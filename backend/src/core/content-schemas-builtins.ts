/** F1 declarations for every core row type stored in the posts table. */

import type { ContentFieldSchema, ContentTypeSchemaV1 } from './content-schema';

const {
    normalizeContentTypeSchema,
    fieldsForFeatures,
    relationshipsForLegacy,
    defaultOperationsFor,
} = require('./content-schema');

interface BuiltinDefinition {
    name: string;
    singular: string;
    plural: string;
    description: string;
    public: boolean;
    showInMenu: boolean;
    showInRest: boolean;
    hasArchive: boolean;
    hierarchical: boolean;
    capabilityType: string;
    features: string[];
    taxonomies: string[];
    menuIcon: string;
    menuPosition: number;
}

function declareBuiltin(definition: BuiltinDefinition): ContentTypeSchemaV1 {
    const fields = fieldsForFeatures(definition.features) as Record<string, ContentFieldSchema>;
    const revisionFields = Object.entries(fields)
        .filter(([, declaredField]) => declaredField.revisioned)
        .map(([name]) => name);
    return normalizeContentTypeSchema({
        schemaVersion: 1,
        name: definition.name,
        labels: {
            singular: definition.singular,
            plural: definition.plural,
            addNew: `Add New ${definition.singular}`,
            edit: `Edit ${definition.singular}`,
        },
        description: definition.description,
        visibility: {
            public: definition.public,
            showInMenu: definition.showInMenu,
            showInRest: definition.showInRest,
            hasArchive: definition.hasArchive,
            hierarchical: definition.hierarchical,
        },
        features: definition.features,
        fields,
        relationships: relationshipsForLegacy(definition.features, definition.taxonomies),
        storage: {
            engine: 'posts',
            table: 'posts',
            discriminator: { column: 'post_type', value: definition.name },
            metaTable: 'post_meta',
        },
        permissions: {
            capabilityType: definition.capabilityType,
            operations: defaultOperationsFor(definition.capabilityType),
        },
        revisions: {
            enabled: definition.features.includes('revisions'),
            strategy: 'snapshot',
            codecVersion: 1,
            fields: revisionFields,
            metaKeys: definition.features.includes('revisions') ? ['_puck_data'] : [],
        },
        presentation: {
            menuIcon: definition.menuIcon,
            menuPosition: definition.menuPosition,
            rewrite: { slug: definition.name },
        },
        extensions: { core: true },
    });
}

const BUILTIN_CONTENT_SCHEMAS: ContentTypeSchemaV1[] = [
    declareBuiltin({
        name: 'post', singular: 'Post', plural: 'Posts',
        description: 'Chronological editorial content.',
        public: true, showInMenu: true, showInRest: true, hasArchive: true, hierarchical: false,
        capabilityType: 'post',
        features: ['title', 'editor', 'author', 'thumbnail', 'excerpt', 'comments', 'revisions'],
        taxonomies: ['category', 'post_tag'], menuIcon: 'fa-pen-to-square', menuPosition: 5,
    }),
    declareBuiltin({
        name: 'page', singular: 'Page', plural: 'Pages',
        description: 'Hierarchical site content.',
        public: true, showInMenu: true, showInRest: true, hasArchive: false, hierarchical: true,
        capabilityType: 'page',
        features: ['title', 'editor', 'author', 'thumbnail', 'excerpt', 'page-attributes', 'revisions'],
        taxonomies: [], menuIcon: 'fa-file-lines', menuPosition: 10,
    }),
    declareBuiltin({
        name: 'attachment', singular: 'Media', plural: 'Media',
        description: 'Uploaded media metadata and ownership.',
        public: true, showInMenu: false, showInRest: true, hasArchive: false, hierarchical: false,
        capabilityType: 'post', features: ['title', 'author', 'comments'], taxonomies: [],
        menuIcon: 'fa-images', menuPosition: 15,
    }),
    declareBuiltin({
        name: 'nav_menu_item', singular: 'Navigation Menu Item', plural: 'Navigation Menu Items',
        description: 'Internal row owned by the menu API.',
        public: false, showInMenu: false, showInRest: false, hasArchive: false, hierarchical: false,
        capabilityType: 'post', features: ['title', 'page-attributes'], taxonomies: [],
        menuIcon: 'fa-bars', menuPosition: 25,
    }),
    declareBuiltin({
        name: 'revision', singular: 'Revision', plural: 'Revisions',
        description: 'Internal immutable content snapshot.',
        public: false, showInMenu: false, showInRest: false, hasArchive: false, hierarchical: false,
        capabilityType: 'post', features: ['title', 'editor', 'excerpt', 'page-attributes'], taxonomies: [],
        menuIcon: 'fa-clock-rotate-left', menuPosition: 25,
    }),
];

function getBuiltinContentSchemas(): ContentTypeSchemaV1[] {
    // Registry callers receive fresh objects, never the module-level declarations.
    return BUILTIN_CONTENT_SCHEMAS.map((schema) => normalizeContentTypeSchema(JSON.parse(JSON.stringify(schema))));
}

module.exports = { getBuiltinContentSchemas };
