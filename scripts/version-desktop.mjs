import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const manifest = 'apps/desktop/package.json';
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function git(...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function main() {
  const { version: current } = JSON.parse(readFileSync(new URL('../' + manifest, import.meta.url), 'utf8'));
  const parts = stable.exec(current);
  if (!parts) throw new Error(`Expected a stable current version, got ${current}.`);
  const suggested = `${parts[1]}.${parts[2]}.${BigInt(parts[3]) + 1n}`;
  console.log(`Current EarthQL Desktop version: ${current}`);

  const input = createInterface({ input: process.stdin, output: process.stdout });
  let next;
  let tagVersion;
  try {
    // Keep one line iterator so the prompts also work with piped input.
    const lines = input[Symbol.asyncIterator]();
    async function ask(prompt) {
      process.stdout.write(prompt);
      const { value, done } = await lines.next();
      if (done) throw new Error('Input ended before confirmation.');
      return value.trim();
    }

    next = (await ask(`New version [${suggested}]: `)) || suggested;
    const nextParts = stable.exec(next);
    if (!nextParts) throw new Error('Enter a stable version in major.minor.patch format.');
    const difference = nextParts.slice(1).map((part, index) => BigInt(part) - BigInt(parts[index + 1])).find((delta) => delta !== 0n);
    if (difference === undefined || difference < 0n) throw new Error(`Choose a version higher than ${current}.`);
    const answer = (await ask(`Commit the version bump and create local Git tag v${next}? [y/N]: `)).toLowerCase();
    if (!['', 'n', 'no', 'y', 'yes'].includes(answer)) throw new Error('Enter y or n.');
    tagVersion = answer === 'y' || answer === 'yes';
  } finally {
    input.close();
  }

  const tag = `v${next}`;
  if (tagVersion) {
    if (git('status', '--porcelain')) throw new Error('Commit your release changes before creating the version commit and tag.');
    if (git('tag', '--list', tag)) throw new Error(`Git tag ${tag} already exists.`);
  }

  execFileSync('npm', ['version', next, '-w', '@earthql/desktop', '--no-git-tag-version'], { cwd, stdio: 'inherit' });
  if (tagVersion) {
    git('commit', '--only', '-m', `Bump EarthQL Desktop to ${next}`, '--', manifest, 'package-lock.json');
    git('tag', '-a', tag, '-m', `EarthQL ${next}`);
  }
  console.log(tagVersion ? `Created local tag ${tag}.` : `Version bumped to ${next}. Review and commit the changed files when ready.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
