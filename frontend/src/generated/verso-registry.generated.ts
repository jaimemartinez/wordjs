/**
 * GENERATED Verso editor registry from contracts/visual-contract.v1.json.
 * Do not edit. Run: npm run generate:f5
 */

import type { CoreBlockCategory, CoreBlockType } from "./visual-contract.types.generated";

export interface GeneratedCoreBlockRegistration {
  readonly type: CoreBlockType;
  readonly category: CoreBlockCategory;
  readonly renderer: CoreBlockType;
  readonly slots: readonly string[];
}

export const GENERATED_CORE_BLOCK_REGISTRY = [
  {
    "type": "Heading",
    "category": "content",
    "renderer": "Heading",
    "slots": []
  },
  {
    "type": "Text",
    "category": "content",
    "renderer": "Text",
    "slots": []
  },
  {
    "type": "Image",
    "category": "content",
    "renderer": "Image",
    "slots": []
  },
  {
    "type": "Divider",
    "category": "layout",
    "renderer": "Divider",
    "slots": []
  },
  {
    "type": "Button",
    "category": "content",
    "renderer": "Button",
    "slots": []
  },
  {
    "type": "Spacer",
    "category": "layout",
    "renderer": "Spacer",
    "slots": []
  },
  {
    "type": "Section",
    "category": "layout",
    "renderer": "Section",
    "slots": [
      "children"
    ]
  },
  {
    "type": "Grid",
    "category": "layout",
    "renderer": "Grid",
    "slots": [
      "children"
    ]
  },
  {
    "type": "FlexRow",
    "category": "layout",
    "renderer": "FlexRow",
    "slots": [
      "children"
    ]
  },
  {
    "type": "Columns",
    "category": "layout",
    "renderer": "Columns",
    "slots": [
      "col-0",
      "col-1",
      "col-2"
    ]
  },
  {
    "type": "Card",
    "category": "content",
    "renderer": "Card",
    "slots": []
  },
  {
    "type": "Quote",
    "category": "content",
    "renderer": "Quote",
    "slots": []
  },
  {
    "type": "Table",
    "category": "content",
    "renderer": "Table",
    "slots": []
  },
  {
    "type": "IconList",
    "category": "content",
    "renderer": "IconList",
    "slots": []
  },
  {
    "type": "SocialLinks",
    "category": "content",
    "renderer": "SocialLinks",
    "slots": []
  },
  {
    "type": "Stats",
    "category": "content",
    "renderer": "Stats",
    "slots": []
  },
  {
    "type": "HTMLEmbed",
    "category": "content",
    "renderer": "HTMLEmbed",
    "slots": []
  },
  {
    "type": "PricingTable",
    "category": "content",
    "renderer": "PricingTable",
    "slots": []
  },
  {
    "type": "Testimonial",
    "category": "content",
    "renderer": "Testimonial",
    "slots": []
  },
  {
    "type": "CTABanner",
    "category": "content",
    "renderer": "CTABanner",
    "slots": []
  },
  {
    "type": "VideoEmbed",
    "category": "content",
    "renderer": "VideoEmbed",
    "slots": []
  },
  {
    "type": "Hero",
    "category": "layout",
    "renderer": "Hero",
    "slots": []
  },
  {
    "type": "PostsGrid",
    "category": "content",
    "renderer": "PostsGrid",
    "slots": []
  },
  {
    "type": "CategoryPosts",
    "category": "content",
    "renderer": "CategoryPosts",
    "slots": []
  },
  {
    "type": "AudioPlayer",
    "category": "content",
    "renderer": "AudioPlayer",
    "slots": []
  },
  {
    "type": "Accordion",
    "category": "layout",
    "renderer": "Accordion",
    "slots": []
  },
  {
    "type": "Tabs",
    "category": "layout",
    "renderer": "Tabs",
    "slots": []
  },
  {
    "type": "SearchBar",
    "category": "content",
    "renderer": "SearchBar",
    "slots": []
  },
  {
    "type": "Form",
    "category": "content",
    "renderer": "Form",
    "slots": []
  },
  {
    "type": "Symbol",
    "category": "content",
    "renderer": "Symbol",
    "slots": []
  },
  {
    "type": "ParticleField",
    "category": "layout",
    "renderer": "ParticleField",
    "slots": []
  },
  {
    "type": "NavMenu",
    "category": "layout",
    "renderer": "NavMenu",
    "slots": []
  },
  {
    "type": "SiteLogo",
    "category": "layout",
    "renderer": "SiteLogo",
    "slots": []
  },
  {
    "type": "BackToTop",
    "category": "layout",
    "renderer": "BackToTop",
    "slots": []
  },
  {
    "type": "OffCanvas",
    "category": "layout",
    "renderer": "OffCanvas",
    "slots": [
      "content"
    ]
  },
  {
    "type": "Breadcrumbs",
    "category": "layout",
    "renderer": "Breadcrumbs",
    "slots": []
  },
  {
    "type": "LangSwitcher",
    "category": "layout",
    "renderer": "LangSwitcher",
    "slots": []
  },
  {
    "type": "TableOfContents",
    "category": "layout",
    "renderer": "TableOfContents",
    "slots": []
  },
  {
    "type": "MegaMenu",
    "category": "layout",
    "renderer": "MegaMenu",
    "slots": [
      "panel0",
      "panel1",
      "panel2",
      "panel3",
      "panel4",
      "panel5"
    ]
  }
] as const satisfies readonly GeneratedCoreBlockRegistration[];
export const CORE_BLOCK_TYPES = GENERATED_CORE_BLOCK_REGISTRY.map((block) => block.type) as readonly CoreBlockType[];
export const CORE_BLOCK_SLOTS: Readonly<Record<CoreBlockType, readonly string[]>> = Object.freeze(
  Object.fromEntries(GENERATED_CORE_BLOCK_REGISTRY.map((block) => [block.type, block.slots])) as unknown as Record<CoreBlockType, readonly string[]>,
);
