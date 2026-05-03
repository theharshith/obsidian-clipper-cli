import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, test } from 'vitest';
import { parseSaveArgs, runCli, saveClipToFolder } from './cli';

const createdDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'obsidian-clipper-cli-'));
	createdDirs.push(dir);
	return dir;
}

function createFetchResponse(html: string): typeof fetch {
	return (async () => ({
		ok: true,
		status: 200,
		statusText: 'OK',
		text: async () => html,
	})) as typeof fetch;
}

function createMockStreams() {
	let stdout = '';
	let stderr = '';

	return {
		stdout: {
			write(chunk: string) {
				stdout += chunk;
				return true;
			},
		},
		stderr: {
			write(chunk: string) {
				stderr += chunk;
				return true;
			},
		},
		getStdout: () => stdout,
		getStderr: () => stderr,
	};
}

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('parseSaveArgs', () => {
	test('parses URL and folder', () => {
		expect(parseSaveArgs(['node', 'cli', 'save', 'https://example.com', '--folder', 'Notes'])).toEqual({
			url: 'https://example.com',
			folder: 'Notes',
		});
	});

	test('uses default folder when omitted', () => {
		expect(parseSaveArgs(['node', 'cli', 'save', 'https://example.com'])).toEqual({
			url: 'https://example.com',
			folder: undefined,
		});
	});
});

describe('saveClipToFolder', () => {
	const html = readFileSync(resolve('src/utils/fixtures/templates/minimal.html'), 'utf-8');

	test('writes a markdown file into the default Clippings folder', async () => {
		const cwd = makeTempDir();
		const filePath = await saveClipToFolder(
			{ url: 'https://example.com/minimal' },
			{
				fetchFn: createFetchResponse(html),
				readFileSync,
				writeFileSync,
				existsSync,
				mkdirSync,
				readdirSync,
				statSync,
				resolvePath: (...parts) => resolve(...parts),
				cwd: () => cwd,
				stdout: { write: () => true },
				stderr: { write: () => true },
			}
		);

		expect(filePath).toContain(join(cwd, 'Clippings'));
		const content = readFileSync(filePath, 'utf-8');
		expect(content).toContain('title: "Minimal Page"');
		expect(content).toContain('source: "https://example.com/minimal"');
		expect(content).toContain('tags:');
	});

	test('creates nested folders and returns the final file path', async () => {
		const cwd = makeTempDir();
		const filePath = await saveClipToFolder(
			{ url: 'https://example.com/minimal', folder: 'Inbox/Articles' },
			{
				fetchFn: createFetchResponse(html),
				readFileSync,
				writeFileSync,
				existsSync,
				mkdirSync,
				readdirSync,
				statSync,
				resolvePath: (...parts) => resolve(...parts),
				cwd: () => cwd,
				stdout: { write: () => true },
				stderr: { write: () => true },
			}
		);

		expect(filePath).toContain(join(cwd, 'Inbox', 'Articles'));
	});

	test('fails when the target file already exists', async () => {
		const cwd = makeTempDir();
		const targetDir = join(cwd, 'Clippings');
		mkdirSync(targetDir, { recursive: true });
		const existingFile = join(targetDir, 'Minimal Page.md');
		writeFileSync(existingFile, 'existing', 'utf-8');

		await expect(saveClipToFolder(
			{ url: 'https://example.com/minimal' },
			{
				fetchFn: createFetchResponse(html),
				readFileSync,
				writeFileSync,
				existsSync,
				mkdirSync,
				readdirSync,
				statSync,
				resolvePath: (...parts) => resolve(...parts),
				cwd: () => cwd,
				stdout: { write: () => true },
				stderr: { write: () => true },
			}
		)).rejects.toThrow(`File already exists at ${existingFile}`);
	});
});

describe('runCli', () => {
	test('prints the saved file path on success', async () => {
		const cwd = makeTempDir();
		const streams = createMockStreams();
		const exitCode = await runCli(
			['node', 'cli', 'save', 'https://example.com/article'],
			{
				fetchFn: createFetchResponse(`
					<html>
						<head><title>CLI output</title></head>
						<body><p>Saved content</p></body>
					</html>
				`),
				readFileSync,
				writeFileSync,
				existsSync,
				mkdirSync,
				readdirSync,
				statSync,
				resolvePath: (...parts) => resolve(...parts),
				cwd: () => cwd,
				stdout: streams.stdout,
				stderr: streams.stderr,
			}
		);

		expect(exitCode).toBe(0);
		expect(streams.getStdout()).toContain('Saved to ');
		expect(streams.getStderr()).toBe('');
	});
});
