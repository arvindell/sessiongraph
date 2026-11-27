import { LibraryError } from './library-query';

/** Translate known storage failures without exposing paths or raw SQLite output. */
export function storageFailure(error: unknown, opening = false): LibraryError | undefined {
  if (error instanceof LibraryError) return error;
  if (!(error instanceof Error)) return;
  const { code, errcode } = error as NodeJS.ErrnoException & { errcode?: number };
  if (code === 'ERR_SQLITE_ERROR' && typeof errcode === 'number') {
    switch (errcode & 0xff) {
      case 5: case 6: return new LibraryError('LIBRARY_BUSY', 'The library is busy. Try again shortly.');
      case 3: case 8: return new LibraryError('LIBRARY_PERMISSIONS', 'Check write permissions for the library folder.');
      case 11: case 26: return new LibraryError('LIBRARY_CORRUPT', 'The library file is damaged or invalid.');
      case 13: return new LibraryError('DISK_FULL', 'Free disk space and try again.');
      case 14: return new LibraryError('LIBRARY_OPEN_FAILED', 'Could not open the library. Check the folder and its permissions.');
      case 10: return new LibraryError('LIBRARY_IO', 'Could not access the library. Check the drive and try again.');
    }
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') return new LibraryError('DISK_FULL', 'Free disk space and try again.');
  if (!opening) return;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new LibraryError('LIBRARY_PERMISSIONS', 'Check write permissions for the library folder.');
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EEXIST' || code === 'EISDIR') return new LibraryError('LIBRARY_OPEN_FAILED', 'Could not open the library. Check the library folder.');
}
