import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDesktopCli } from './cli-install';

try {
  const executable = process.argv[2];
  if (!executable) throw new Error('Missing desktop application path.');
  await installDesktopCli({ resources: dirname(fileURLToPath(import.meta.url)), executable });
} catch (error) {
  console.error(`SessionGraph CLI setup failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
