type DirectoryClickEntry = {
  isGitRepo: boolean
}

type DirectoryClickAction = 'browse' | 'select-and-browse'

export function getDirectoryClickAction(entry: DirectoryClickEntry): DirectoryClickAction {
  if (entry.isGitRepo) {
    return 'select-and-browse'
  }

  return 'browse'
}
