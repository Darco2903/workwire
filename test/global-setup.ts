import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Build the package once: the packaged-usage tests import it by name.
export default function setup(): void {
  execFileSync('pnpm', ['-s', 'build'], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit' });
}
