// Browser globals (DOMParser, window, document) are provided by the esbuild
// banner in scripts/build-cli.mjs. They must run before any bundled module code.
import { parseHTML } from 'linkedom';
import * as fs from 'fs';
import * as path from 'path';
import { clip, matchTemplate, DocumentParser } from './api';
import { Template } from './types/types';
import { openInObsidian } from './utils/cli-utils';
import { createDefaultTemplate } from './utils/default-template';

interface LegacyCliArgs {
	url: string;
	templatePath: string;
	outputPath?: string;
	vault?: string;
	open: boolean;
	silent: boolean;
	uri: boolean;
	propertyTypesPath?: string;
	htmlPath?: string;
}

export interface SaveCliArgs {
	url: string;
	folder?: string;
}

interface CliDependencies {
	fetchFn: typeof fetch;
	readFileSync: typeof fs.readFileSync;
	writeFileSync: typeof fs.writeFileSync;
	existsSync: typeof fs.existsSync;
	mkdirSync: typeof fs.mkdirSync;
	readdirSync: typeof fs.readdirSync;
	statSync: typeof fs.statSync;
	resolvePath: (...paths: string[]) => string;
	cwd: () => string;
	stdout: Pick<NodeJS.WriteStream, 'write'>;
	stderr: Pick<NodeJS.WriteStream, 'write'>;
}

const defaultDependencies: CliDependencies = {
	fetchFn: fetch,
	readFileSync: fs.readFileSync,
	writeFileSync: fs.writeFileSync,
	existsSync: fs.existsSync,
	mkdirSync: fs.mkdirSync,
	readdirSync: fs.readdirSync,
	statSync: fs.statSync,
	resolvePath: path.resolve,
	cwd: () => process.cwd(),
	stdout: process.stdout,
	stderr: process.stderr,
};

class CliError extends Error {
	exitCode: number;
	showGeneralUsage: boolean;

	constructor(message: string, exitCode = 1, showGeneralUsage = false) {
		super(message);
		this.exitCode = exitCode;
		this.showGeneralUsage = showGeneralUsage;
	}
}

const templateFilePaths = new Map<Template, string>();

const linkedomParser: DocumentParser = {
	parseFromString(html: string, _mimeType: string) {
		return parseHTML(html).document;
	}
};

function ensureCliDomGlobals(): void {
	class LinkedomDomParser {
		parseFromString(html: string) {
			return parseHTML(html).document;
		}
	}

	const createEmptyDocument = () => parseHTML('<!DOCTYPE html><html><head></head><body></body></html>').document;

	if (typeof globalThis.window === 'undefined') {
		(globalThis as any).window = globalThis;
	}

	if (typeof globalThis.DOMParser === 'undefined') {
		(globalThis as any).DOMParser = LinkedomDomParser;
	}

	if (typeof (globalThis as any).window.DOMParser === 'undefined') {
		(globalThis as any).window.DOMParser = LinkedomDomParser;
	}

	if (typeof globalThis.document === 'undefined') {
		(globalThis as any).document = createEmptyDocument();
	}

	const globalDocument = globalThis.document as any;
	if (!globalDocument.implementation) {
		globalDocument.implementation = {};
	}
	if (typeof globalDocument.implementation.createHTMLDocument !== 'function') {
		globalDocument.implementation.createHTMLDocument = () => createEmptyDocument();
	}
}

function getGeneralUsage(): string {
	return `
Usage:
  obsidian-clipper save <url> [options]
  obsidian-clipper <url> [options]

Commands:
  save                       Save a clipped note directly to disk

Save options:
      --folder <path>        Destination folder (default: Clippings)
  -h, --help                 Show this help message

Legacy options:
  -t, --template <path>      Path to template JSON file or directory (required)
                             If a directory, auto-matches template by URL triggers
  -o, --output <path>        Output .md file path (default: stdout)
      --html <path>          Read HTML from file instead of fetching URL (use - for stdin)
      --vault <name>         Obsidian vault name
      --open                 Send to Obsidian instead of writing file
      --uri                  Use URI scheme instead of Obsidian CLI
      --silent               Suppress Obsidian focus (URI mode)
      --property-types <path>
                             JSON mapping property names to types
  -h, --help                 Show this help message
`.trim();
}

function printGeneralUsage(deps: CliDependencies): void {
	deps.stdout.write(getGeneralUsage() + '\n');
}

function resolveOutputFolder(folder: string | undefined, deps: Pick<CliDependencies, 'resolvePath' | 'cwd'>): string {
	const defaultFolder = createDefaultTemplate().path || 'Clippings';
	const targetFolder = folder?.trim() || defaultFolder;
	return path.isAbsolute(targetFolder) ? targetFolder : deps.resolvePath(deps.cwd(), targetFolder);
}

function loadTemplatesFromDir(dirPath: string, deps: Pick<CliDependencies, 'resolvePath' | 'readdirSync' | 'readFileSync'>): Template[] {
	const resolved = deps.resolvePath(dirPath);
	const files = deps.readdirSync(resolved).filter(fileName => fileName.endsWith('.json'));
	return files.map(fileName => {
		const filePath = path.join(resolved, fileName);
		const raw = deps.readFileSync(filePath, 'utf-8');
		const template: Template = JSON.parse(raw);
		templateFilePaths.set(template, filePath);
		return template;
	});
}

export function parseSaveArgs(argv: string[]): SaveCliArgs {
	const args = argv.slice(3);
	let url = '';
	let folder: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case '-h':
			case '--help':
				throw new CliError('', 0, true);
			case '--folder':
				if (i + 1 >= args.length) {
					throw new CliError('Error: --folder requires a value', 1, true);
				}
				folder = args[++i];
				break;
			default:
				if (!arg.startsWith('-') && !url) {
					url = arg;
				} else {
					throw new CliError(`Unknown option: ${arg}`, 1, true);
				}
		}
	}

	if (!url) {
		throw new CliError('Error: URL is required', 1, true);
	}

	return { url, folder };
}

function parseLegacyArgs(argv: string[]): LegacyCliArgs {
	const args = argv.slice(2);
	let url = '';
	let templatePath = '';
	let outputPath: string | undefined;
	let vault: string | undefined;
	let open = false;
	let silent = false;
	let uri = false;
	let propertyTypesPath: string | undefined;
	let htmlPath: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case '-h':
			case '--help':
				throw new CliError('', 0, true);
			case '-t':
			case '--template':
				if (i + 1 >= args.length) {
					throw new CliError('Error: --template requires a value', 1, true);
				}
				templatePath = args[++i];
				break;
			case '-o':
			case '--output':
				if (i + 1 >= args.length) {
					throw new CliError('Error: --output requires a value', 1, true);
				}
				outputPath = args[++i];
				break;
			case '--vault':
				if (i + 1 >= args.length) {
					throw new CliError('Error: --vault requires a value', 1, true);
				}
				vault = args[++i];
				break;
			case '--open':
				open = true;
				break;
			case '--silent':
				silent = true;
				break;
			case '--uri':
				uri = true;
				break;
			case '--html':
				if (i + 1 >= args.length) {
					throw new CliError('Error: --html requires a value', 1, true);
				}
				htmlPath = args[++i];
				break;
			case '--property-types':
				if (i + 1 >= args.length) {
					throw new CliError('Error: --property-types requires a value', 1, true);
				}
				propertyTypesPath = args[++i];
				break;
			default:
				if (!arg.startsWith('-') && !url) {
					url = arg;
				} else {
					throw new CliError(`Unknown option: ${arg}`, 1, true);
				}
		}
	}

	if (!url) {
		throw new CliError('Error: URL is required', 1, true);
	}

	if (!templatePath) {
		throw new CliError('Error: --template is required', 1, true);
	}

	return { url, templatePath, outputPath, vault, open, silent, uri, propertyTypesPath, htmlPath };
}

async function fetchHtml(url: string, deps: Pick<CliDependencies, 'fetchFn'>): Promise<string> {
	const response = await deps.fetchFn(url);
	if (!response.ok) {
		throw new CliError(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
	}
	return response.text();
}

function ensureParentDirectory(filePath: string, deps: Pick<CliDependencies, 'existsSync' | 'mkdirSync'>): void {
	const parentDir = path.dirname(filePath);
	if (!deps.existsSync(parentDir)) {
		deps.mkdirSync(parentDir, { recursive: true });
	}
}

export async function saveClipToFolder(
	args: SaveCliArgs,
	deps: CliDependencies = defaultDependencies
): Promise<string> {
	ensureCliDomGlobals();
	const template = createDefaultTemplate({ name: 'Default' });
	const html = await fetchHtml(args.url, deps);
	const result = await clip({
		html,
		url: args.url,
		template,
		documentParser: linkedomParser,
	});

	const outputFolder = resolveOutputFolder(args.folder, deps);
	const filePath = path.join(outputFolder, `${result.noteName}.md`);
	if (deps.existsSync(filePath)) {
		throw new CliError(`Error: File already exists at ${filePath}`);
	}

	ensureParentDirectory(filePath, deps);
	deps.writeFileSync(filePath, result.fullContent, 'utf-8');
	return filePath;
}

async function runSaveCommand(argv: string[], deps: CliDependencies): Promise<void> {
	const args = parseSaveArgs(argv);
	const filePath = await saveClipToFolder(args, deps);
	deps.stdout.write(`Saved to ${filePath}\n`);
}

async function runLegacyCommand(argv: string[], deps: CliDependencies): Promise<void> {
	const args = parseLegacyArgs(argv);
	ensureCliDomGlobals();
	const resolvedTemplatePath = deps.resolvePath(args.templatePath);
	const isDir = deps.statSync(resolvedTemplatePath).isDirectory();
	let templates: Template[] | undefined;
	let template: Template | undefined;

	if (isDir) {
		templates = loadTemplatesFromDir(resolvedTemplatePath, deps);
		if (templates.length === 0) {
			throw new CliError(`Error: No .json template files found in ${args.templatePath}`);
		}
	} else {
		const templateRaw = deps.readFileSync(resolvedTemplatePath, 'utf-8');
		template = JSON.parse(templateRaw);
	}

	let propertyTypes: Record<string, string> | undefined;
	if (args.propertyTypesPath) {
		const raw = deps.readFileSync(deps.resolvePath(args.propertyTypesPath), 'utf-8');
		propertyTypes = JSON.parse(raw);
	}

	let html: string;
	if (args.htmlPath) {
		if (args.htmlPath === '-') {
			html = deps.readFileSync(0, 'utf-8');
		} else {
			html = deps.readFileSync(deps.resolvePath(args.htmlPath), 'utf-8');
		}
	} else {
		html = await fetchHtml(args.url, deps);
	}

	let parsedDocument: any;
	if (templates) {
		let matched = matchTemplate(templates, args.url);

		if (!matched) {
			const hasSchemaTriggers = templates.some(t => t.triggers?.some(trigger => trigger.startsWith('schema:')));
			if (hasSchemaTriggers) {
				const DefuddleClass = (await import('defuddle')).default;
				parsedDocument = linkedomParser.parseFromString(html, 'text/html');
				const defuddle = new DefuddleClass(parsedDocument as unknown as Document, { url: args.url });
				const defuddleResult = defuddle.parse();
				matched = matchTemplate(templates, args.url, defuddleResult.schemaOrgData);
			}
		}

		if (!matched) {
			throw new CliError(`Error: No template matched URL ${args.url}\nSearched ${templates.length} templates in ${args.templatePath}`);
		}

		template = matched;
		deps.stderr.write(`Matched template: ${templateFilePaths.get(template) || 'unknown'}\n`);
	}

	if (!template) {
		throw new CliError('Error: No template resolved');
	}

	const result = await clip({
		html,
		url: args.url,
		template,
		documentParser: linkedomParser,
		propertyTypes,
		parsedDocument,
	});

	if (args.open) {
		const vault = args.vault || template.vault || '';
		const obsidianResult = await openInObsidian(
			result.fullContent,
			result.noteName,
			template.path || '',
			vault,
			template.behavior || 'create',
			args.silent,
			args.uri
		);
		deps.stderr.write(`${obsidianResult}\n`);
		return;
	}

	if (args.outputPath) {
		deps.writeFileSync(deps.resolvePath(args.outputPath), result.fullContent, 'utf-8');
		deps.stderr.write(`Written to ${args.outputPath}\n`);
		return;
	}

	deps.stdout.write(result.fullContent);
}

export async function runCli(argv: string[], deps: CliDependencies = defaultDependencies): Promise<number> {
	try {
		if (argv.length <= 2) {
			throw new CliError('Error: Missing command or URL', 1, true);
		}

		if (argv[2] === 'save') {
			await runSaveCommand(argv, deps);
			return 0;
		}

		if (argv[2] === '-h' || argv[2] === '--help') {
			printGeneralUsage(deps);
			return 0;
		}

		await runLegacyCommand(argv, deps);
		return 0;
	} catch (error) {
		if (error instanceof CliError) {
			if (error.message) {
				deps.stderr.write(error.message + '\n');
			}
			if (error.showGeneralUsage) {
				printGeneralUsage(deps);
			}
			return error.exitCode;
		}

		const message = error instanceof Error ? error.message : String(error);
		deps.stderr.write(message + '\n');
		return 1;
	}
}

export async function main(): Promise<void> {
	const exitCode = await runCli(process.argv);
	if (exitCode !== 0) {
		process.exit(exitCode);
	}
}

const isDirectExecution = typeof require !== 'undefined'
	&& typeof module !== 'undefined'
	&& require.main === module;

if (isDirectExecution) {
	main().catch(error => {
		process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
		process.exit(1);
	});
}
