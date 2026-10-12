import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { finished } from 'node:stream/promises';

import { ZipArchive } from 'archiver';

const sourceDirectory = resolve('wordpress-plugin/servicetitan-job-integration');
const outputDirectory = resolve('dist/downloads');
const outputFile = join(outputDirectory, 'job-showcase-for-servicetitan-1.19.2.zip');

await mkdir(outputDirectory, { recursive: true });

const output = createWriteStream(outputFile);
// Small plugin: store buffered entries so CRCs and sizes are in local headers.
// Avoid streaming data descriptors and ZIP64 for older hosting ZIP readers.
const archive = new ZipArchive({ store: true, forceZip64: false });
archive.on('error', (error) => output.destroy(error));
archive.pipe(output);
async function appendDirectory(directory, prefix) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const filePath = join(directory, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await appendDirectory(filePath, name);
    } else if (entry.isFile()) {
      archive.append(await readFile(filePath), { name, mode: 0o644 });
    }
  }
}
await appendDirectory(sourceDirectory, basename(sourceDirectory));

await archive.finalize();
await finished(output);

console.log(`Packaged WordPress plugin: ${relative(process.cwd(), outputFile)}`);
