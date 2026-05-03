import { Template, Property } from '../types/types';

export interface DefaultTemplateOptions {
	name?: string;
	templateId?: string;
	createId?: () => string;
	path?: string;
}

function buildProperty(
	name: string,
	value: string,
	type: string | undefined,
	createId?: () => string
): Property {
	return {
		id: createId ? createId() : undefined,
		name,
		value,
		type,
	};
}

export function createDefaultTemplate(options: DefaultTemplateOptions = {}): Template {
	const {
		name = 'Default',
		templateId = 'default-template',
		createId,
		path = 'Clippings',
	} = options;

	return {
		id: templateId,
		name,
		behavior: 'create',
		noteNameFormat: '{{title}}',
		path,
		noteContentFormat: '{{content}}',
		context: '',
		properties: [
			buildProperty('title', '{{title}}', 'text', createId),
			buildProperty('source', '{{url}}', 'text', createId),
			buildProperty('author', '{{author|split:", "|wikilink|join}}', 'multitext', createId),
			buildProperty('published', '{{published}}', 'date', createId),
			buildProperty('created', '{{date}}', 'date', createId),
			buildProperty('description', '{{description}}', 'text', createId),
			buildProperty('tags', 'clippings', 'multitext', createId),
		],
		triggers: [],
	};
}
