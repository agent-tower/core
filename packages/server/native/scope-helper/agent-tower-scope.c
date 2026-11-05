/*
 * agent-tower-scope: per-scope supervisor for processes started by Agent Tower.
 *
 * The supervisor becomes a child subreaper (Linux >= 3.4), starts exactly one
 * command, and keeps running until every process started below it has exited.
 * Processes that re-parent (their parent exits), call setsid(), or clear their
 * environment stay attached to the supervisor, so no process-table sampling is
 * needed to know what belongs to the scope.
 *
 * Lifecycle:
 *   - command exits        -> forward --root-exit-signal to what remains,
 *                             escalate after --grace, exit when the scope is empty
 *   - SIGTERM/SIGHUP/SIGINT -> forward that signal, escalate after --grace
 *   - SIGUSR1              -> escalate immediately
 *   - parent dies (--pdeathsig) -> same as SIGTERM
 * The supervisor exits with the command's exit status (or re-raises its signal)
 * once wait() reports no remaining children, which is the "scope empty" event.
 *
 * Usage:
 *   agent-tower-scope [--id ID] [--grace MS] [--root-exit-signal SIGHUP|SIGTERM|SIGINT|none]
 *                     [--pdeathsig] [--status-fd N] -- command [args...]
 *   agent-tower-scope --probe   (prints capabilities as JSON)
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif
#ifndef SYS_pidfd_send_signal
#define SYS_pidfd_send_signal 424
#endif

#define SCOPE_PROTOCOL_VERSION 1
#define STOP_POLL_MS 25
#define EXIT_SETUP_FAILED 126
#define EXIT_EXEC_FAILED 127

typedef struct { pid_t *items; size_t count, capacity; } pidlist;

static void pidlist_add(pidlist *list, pid_t pid) {
  if (list->count == list->capacity) {
    size_t next = list->capacity ? list->capacity * 2 : 64;
    pid_t *grown = realloc(list->items, next * sizeof *grown);
    if (!grown) { perror("agent-tower-scope: realloc"); _exit(EXIT_SETUP_FAILED); }
    list->items = grown;
    list->capacity = next;
  }
  list->items[list->count++] = pid;
}

static int pidlist_has(const pidlist *list, pid_t pid) {
  for (size_t i = 0; i < list->count; i++) if (list->items[i] == pid) return 1;
  return 0;
}

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* Reads /proc/<pid>/task/<tid>/children. Returns -1 when the file does not exist. */
static int read_children(pid_t pid, pid_t tid, pidlist *out) {
  char path[80];
  snprintf(path, sizeof path, "/proc/%d/task/%d/children", (int)pid, (int)tid);
  FILE *file = fopen(path, "r");
  if (!file) return -1;
  int value;
  while (fscanf(file, "%d", &value) == 1) pidlist_add(out, (pid_t)value);
  fclose(file);
  return 0;
}

/* Appends the children of every thread of pid. Returns -1 if children files are unsupported. */
static int add_task_children(pid_t pid, pidlist *out) {
  char path[48];
  snprintf(path, sizeof path, "/proc/%d/task", (int)pid);
  DIR *dir = opendir(path);
  if (!dir) return 0; /* the process is already gone */
  struct dirent *entry;
  int seen = 0, supported = 0;
  while ((entry = readdir(dir))) {
    if (!isdigit((unsigned char)entry->d_name[0])) continue;
    seen = 1;
    if (read_children(pid, (pid_t)atoi(entry->d_name), out) == 0) supported = 1;
  }
  closedir(dir);
  return (seen && !supported) ? -1 : 0;
}

/* Fallback for kernels built without CONFIG_PROC_CHILDREN: one pass over /proc. */
static void collect_by_scan(pid_t root, pidlist *out) {
  DIR *dir = opendir("/proc");
  if (!dir) return;
  pidlist pids = {0}, parents = {0};
  struct dirent *entry;
  while ((entry = readdir(dir))) {
    if (!isdigit((unsigned char)entry->d_name[0])) continue;
    char path[300];
    snprintf(path, sizeof path, "/proc/%s/stat", entry->d_name);
    FILE *file = fopen(path, "r");
    if (!file) continue;
    char buffer[512];
    size_t length = fread(buffer, 1, sizeof buffer - 1, file);
    fclose(file);
    buffer[length] = 0;
    char *close_paren = strrchr(buffer, ')');
    if (!close_paren) continue;
    char state;
    int parent;
    if (sscanf(close_paren + 1, " %c %d", &state, &parent) != 2) continue;
    pidlist_add(&pids, (pid_t)atoi(entry->d_name));
    pidlist_add(&parents, (pid_t)parent);
  }
  closedir(dir);
  int changed = 1;
  while (changed) {
    changed = 0;
    for (size_t i = 0; i < pids.count; i++) {
      if (pidlist_has(out, pids.items[i])) continue;
      if (parents.items[i] == root || pidlist_has(out, parents.items[i])) {
        pidlist_add(out, pids.items[i]);
        changed = 1;
      }
    }
  }
  free(pids.items);
  free(parents.items);
}

/* Every process currently below the supervisor, breadth first. */
static void collect_descendants(pidlist *out) {
  out->count = 0;
  pid_t self = getpid();
  if (add_task_children(self, out) < 0) { collect_by_scan(self, out); return; }
  for (size_t i = 0; i < out->count; i++) add_task_children(out->items[i], out);
}

static int pidfd_state = -1; /* -1 unknown, 0 unsupported, 1 supported */

/* Signals one scope member. pidfd avoids ever addressing a reused PID. */
static void signal_member(pid_t pid, int sig) {
  if (pidfd_state != 0) {
    int fd = (int)syscall(SYS_pidfd_open, pid, 0);
    if (fd >= 0) {
      pidfd_state = 1;
      syscall(SYS_pidfd_send_signal, fd, sig, NULL, 0);
      close(fd);
      return;
    }
    if (errno == ENOSYS) pidfd_state = 0;
    else return; /* ESRCH: the member already exited */
  }
  kill(pid, sig);
}

static void signal_members(const pidlist *members, pidlist *signalled, int sig) {
  for (size_t i = 0; i < members->count; i++) {
    pid_t pid = members->items[i];
    if (pidlist_has(signalled, pid)) continue;
    signal_member(pid, sig);
    /* A stopped job must be resumed to act on a graceful request. */
    if (sig != SIGKILL) signal_member(pid, SIGCONT);
    pidlist_add(signalled, pid);
  }
}

static int status_fd = -1;

static void report(const char *format, ...) {
  if (status_fd < 0) return;
  char line[128];
  va_list args;
  va_start(args, format);
  int length = vsnprintf(line, sizeof line, format, args);
  va_end(args);
  if (length <= 0) return;
  size_t bytes = (size_t)length < sizeof line ? (size_t)length : sizeof line - 1;
  ssize_t written = write(status_fd, line, bytes);
  (void)written;
}

static int parse_signal(const char *name) {
  if (!strcmp(name, "none")) return 0;
  if (!strcmp(name, "SIGHUP")) return SIGHUP;
  if (!strcmp(name, "SIGTERM")) return SIGTERM;
  if (!strcmp(name, "SIGINT")) return SIGINT;
  return -1;
}

static int usage(void) {
  fprintf(stderr, "usage: agent-tower-scope [--id ID] [--grace MS] [--root-exit-signal SIGHUP|SIGTERM|SIGINT|none] [--pdeathsig] [--status-fd N] -- command [args...]\n");
  return EXIT_SETUP_FAILED;
}

static int probe(void) {
  int subreaper = prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == 0;
  if (subreaper) prctl(PR_SET_CHILD_SUBREAPER, 0, 0, 0, 0);
  int pidfd = 0;
  int fd = (int)syscall(SYS_pidfd_open, getpid(), 0);
  if (fd >= 0) { pidfd = 1; close(fd); }
  char path[80];
  snprintf(path, sizeof path, "/proc/self/task/%d/children", (int)syscall(SYS_gettid));
  int children = access(path, R_OK) == 0;
  printf("{\"version\":%d,\"subreaper\":%s,\"pidfd\":%s,\"childrenFile\":%s}\n",
         SCOPE_PROTOCOL_VERSION, subreaper ? "true" : "false", pidfd ? "true" : "false", children ? "true" : "false");
  return subreaper ? 0 : 1;
}

int main(int argc, char **argv) {
  long grace_ms = 2000;
  int root_exit_signal = SIGTERM;
  int pdeathsig = 0;
  int command_index = -1;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--")) { command_index = i + 1; break; }
    if (!strcmp(argv[i], "--probe")) return probe();
    if (!strcmp(argv[i], "--version")) { printf("agent-tower-scope protocol %d\n", SCOPE_PROTOCOL_VERSION); return 0; }
    if (!strcmp(argv[i], "--pdeathsig")) { pdeathsig = 1; continue; }
    if (i + 1 >= argc) return usage();
    if (!strcmp(argv[i], "--id")) { i++; /* visible in ps for diagnostics only */ }
    else if (!strcmp(argv[i], "--grace")) grace_ms = strtol(argv[++i], NULL, 10);
    else if (!strcmp(argv[i], "--root-exit-signal")) { root_exit_signal = parse_signal(argv[++i]); if (root_exit_signal < 0) return usage(); }
    else if (!strcmp(argv[i], "--status-fd")) status_fd = (int)strtol(argv[++i], NULL, 10);
    else return usage();
  }
  if (command_index < 0 || command_index >= argc || grace_ms < 0) return usage();

  pid_t launcher = getppid();
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
    perror("agent-tower-scope: PR_SET_CHILD_SUBREAPER");
    return EXIT_SETUP_FAILED;
  }
  if (pdeathsig) {
    if (prctl(PR_SET_PDEATHSIG, SIGTERM, 0, 0, 0) != 0) {
      perror("agent-tower-scope: PR_SET_PDEATHSIG");
      return EXIT_SETUP_FAILED;
    }
    /* The launcher may have exited before the flag was set; do not start anything then. */
    if (getppid() != launcher) return EXIT_SETUP_FAILED;
  }
  if (status_fd >= 0) fcntl(status_fd, F_SETFD, FD_CLOEXEC);

  signal(SIGTTOU, SIG_IGN);
  signal(SIGTTIN, SIG_IGN);
  signal(SIGPIPE, SIG_IGN);
  sigset_t mask;
  sigemptyset(&mask);
  int watched[] = { SIGCHLD, SIGTERM, SIGHUP, SIGINT, SIGQUIT, SIGUSR1, SIGUSR2 };
  for (size_t i = 0; i < sizeof watched / sizeof *watched; i++) sigaddset(&mask, watched[i]);
  sigprocmask(SIG_BLOCK, &mask, NULL);

  int tty = isatty(STDIN_FILENO);
  pid_t root = fork();
  if (root < 0) {
    perror("agent-tower-scope: fork");
    return EXIT_SETUP_FAILED;
  }
  if (root == 0) {
    sigset_t none;
    sigemptyset(&none);
    sigprocmask(SIG_SETMASK, &none, NULL);
    signal(SIGPIPE, SIG_DFL);
    signal(SIGTTIN, SIG_DFL);
    /* Own process group; on a terminal it becomes the foreground group so
       terminal-generated signals never reach the supervisor. */
    setpgid(0, 0);
    if (tty) tcsetpgrp(STDIN_FILENO, getpid());
    signal(SIGTTOU, SIG_DFL);
    execvp(argv[command_index], argv + command_index);
    fprintf(stderr, "agent-tower-scope: cannot execute %s: %s\n", argv[command_index], strerror(errno));
    _exit(EXIT_EXEC_FAILED);
  }
  setpgid(root, root);
  if (tty) tcsetpgrp(STDIN_FILENO, root);

  pidlist members = {0}, signalled = {0};
  int root_exited = 0, root_status = 0, stopping = 0, current_signal = 0, empty = 0;
  long long stop_started = 0;
  struct timespec poll = { 0, STOP_POLL_MS * 1000000L };
  while (!empty) {
    siginfo_t info;
    int sig = stopping ? sigtimedwait(&mask, &info, &poll) : sigwaitinfo(&mask, &info);
    if (sig < 0 && errno != EAGAIN && errno != EINTR) {
      perror("agent-tower-scope: sigwait");
      break;
    }
    /* Reap everything that exited, including orphans re-parented to the supervisor. */
    for (;;) {
      int status;
      pid_t pid = waitpid(-1, &status, WNOHANG);
      if (pid > 0) {
        if (pid == root && !root_exited) {
          root_exited = 1;
          root_status = status;
          report("root-exit %d %d\n", WIFEXITED(status) ? WEXITSTATUS(status) : -1, WIFSIGNALED(status) ? WTERMSIG(status) : 0);
          if (!stopping && root_exit_signal) {
            stopping = 1;
            current_signal = root_exit_signal;
            stop_started = now_ms();
            signalled.count = 0;
          }
        }
        continue;
      }
      if (pid < 0 && errno == ECHILD) empty = 1;
      break;
    }
    if (empty) break;
    if (sig == SIGTERM || sig == SIGHUP || sig == SIGINT || sig == SIGQUIT || sig == SIGUSR1) {
      int requested = sig == SIGUSR1 ? SIGKILL : sig;
      if (!stopping) stop_started = now_ms();
      stopping = 1;
      if (current_signal != SIGKILL && requested != current_signal) {
        current_signal = requested;
        signalled.count = 0;
      }
    }
    if (!stopping) continue;
    if (current_signal != SIGKILL && now_ms() - stop_started >= grace_ms) {
      current_signal = SIGKILL;
      signalled.count = 0;
    }
    collect_descendants(&members);
    signal_members(&members, &signalled, current_signal);
  }
  report("empty\n");
  free(members.items);
  free(signalled.items);
  if (!root_exited) return EXIT_SETUP_FAILED;
  if (WIFSIGNALED(root_status)) {
    int sig = WTERMSIG(root_status);
    signal(sig, SIG_DFL);
    sigset_t none;
    sigemptyset(&none);
    sigprocmask(SIG_SETMASK, &none, NULL);
    raise(sig);
    return 128 + sig;
  }
  return WIFEXITED(root_status) ? WEXITSTATUS(root_status) : EXIT_SETUP_FAILED;
}
