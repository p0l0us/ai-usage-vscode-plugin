import * as fs from 'fs';
import * as path from 'path';

/** The version of this service package, from its package.json. */
export function serviceVersion(): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch { return '0.0.0'; }
}

/** The directory of this service package: package.json, bin/ and out/. */
export function servicePackageDir(): string {
  return path.join(__dirname, '..');
}

/** Negative when a is older than b, positive when newer, 0 when equal; non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let index = 0; index < Math.max(pa.length, pb.length); index++) {
    const difference = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (difference !== 0) { return difference; }
  }
  return 0;
}
