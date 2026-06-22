type DirectoryClickEntry = {
  isGitRepo: boolean
}

type DirectoryClickAction = 'browse' | 'select-and-browse'

export type DirectoryClickValidationMode = 'git' | 'directory'

export function getDirectoryClickAction(
  entry: DirectoryClickEntry,
  validationMode: DirectoryClickValidationMode = 'git',
): DirectoryClickAction {
  if (validationMode === 'directory') {
    return 'select-and-browse'
  }

  if (entry.isGitRepo) {
    return 'select-and-browse'
  }

  return 'browse'
}
