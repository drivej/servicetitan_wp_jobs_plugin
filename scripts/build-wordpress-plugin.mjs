import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { finished } from 'node:stream/promises';

import { ZipArchive } from 'archiver';

const sourceDirectory = resolve('wordpress-plugin/servicetitan-job-integration');
const outputDirectory = resolve('dist/downloads');
const outputFile = join(outputDirectory, 'servicetitan-job-integration-1.18.0.zip');

await mkdir(outputDirectory, { recursive: true });

const output = createWriteStream(outputFile);
const archive = new ZipArchive({ zlib: { level: 9 } });
archive.pipe(output);
archive.directory(sourceDirectory, basename(sourceDirectory));

await archive.finalize();
await finished(output);

console.log(`Packaged WordPress plugin: ${relative(process.cwd(), outputFile)}`);
