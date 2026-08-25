/**
 * GENERATED TypeScript types from contracts/visual-contract.v1.json.
 * Do not edit. Run: npm run generate:f5
 */

export type VisualContractVersion = 1;
export type TemplateBlockType = "PageContent" | "Section" | "Grid" | "FlexRow" | "Columns" | "Spacer" | "Divider" | "PostsGrid" | "CategoryPosts" | "SearchBar" | "TemplatePart";
export type ChromeBlockType = "ChromeLogo" | "ChromeSiteTitle" | "ChromeNav" | "ChromeSearch" | "ChromeSocials" | "ChromeText" | "ChromeButton" | "ChromeSpacer" | "ChromeRow";
export type CoreBlockType = "Heading" | "Text" | "Image" | "Divider" | "Button" | "Spacer" | "Section" | "Grid" | "FlexRow" | "Columns" | "Card" | "Quote" | "Table" | "IconList" | "SocialLinks" | "Stats" | "HTMLEmbed" | "PricingTable" | "Testimonial" | "CTABanner" | "VideoEmbed" | "Hero" | "PostsGrid" | "CategoryPosts" | "AudioPlayer" | "Accordion" | "Tabs" | "SearchBar" | "Form" | "Symbol" | "ParticleField" | "NavMenu" | "SiteLogo" | "BackToTop" | "OffCanvas" | "Breadcrumbs" | "LangSwitcher" | "TableOfContents" | "MegaMenu";
export type CoreBlockCategory = "content" | "layout";
export type TemplatePartArea = "header" | "footer" | "sidebar" | "general";

export interface GeneratedTemplatePropsByType {
  readonly "PageContent": { readonly id?: string; };
  readonly "Section": { readonly id?: string; readonly "background"?: string; readonly "padding"?: string; readonly "maxWidth"?: string; readonly "tag"?: string; readonly "className"?: string; readonly "items"?: GeneratedTemplateBlock[]; };
  readonly "Grid": { readonly id?: string; readonly "columns"?: number; readonly "gap"?: string; readonly "columnsTablet"?: number; readonly "columnsMobile"?: number; readonly "tag"?: string; readonly "className"?: string; readonly "items"?: GeneratedTemplateBlock[]; };
  readonly "FlexRow": { readonly id?: string; readonly "gap"?: string; readonly "align"?: "start" | "center" | "end" | "stretch"; readonly "justify"?: "start" | "center" | "end" | "between" | "around"; readonly "wrap"?: boolean; readonly "direction"?: "row" | "column" | "row-reverse" | "column-reverse"; readonly "tag"?: string; readonly "className"?: string; readonly "items"?: GeneratedTemplateBlock[]; };
  readonly "Columns": { readonly id?: string; readonly "columns"?: number; readonly "gap"?: string; readonly "tag"?: string; readonly "className"?: string; readonly "items"?: GeneratedTemplateBlock[]; };
  readonly "Spacer": { readonly id?: string; readonly "height"?: string; };
  readonly "Divider": { readonly id?: string; readonly "color"?: string; readonly "width"?: string; readonly "length"?: string; readonly "gap"?: string; };
  readonly "PostsGrid": { readonly id?: string; readonly "count"?: number; readonly "columns"?: number; readonly "gap"?: string; readonly "bg"?: string; readonly "borderColor"?: string; readonly "radius"?: string; readonly "pad"?: string; readonly "thumbHeight"?: string; };
  readonly "CategoryPosts": { readonly id?: string; readonly "count"?: number; readonly "categorySlug"?: string; readonly "layout"?: "grid" | "list"; readonly "columns"?: number; readonly "gap"?: string; readonly "bg"?: string; readonly "borderColor"?: string; readonly "radius"?: string; readonly "linkColor"?: string; readonly "headingColor"?: string; };
  readonly "SearchBar": { readonly id?: string; readonly "placeholder"?: string; readonly "buttonText"?: string; readonly "align"?: "left" | "center" | "right"; readonly "width"?: string; readonly "inputBg"?: string; readonly "inputBorderColor"?: string; readonly "inputRadius"?: string; readonly "buttonBg"?: string; readonly "buttonColor"?: string; readonly "buttonRadius"?: string; };
  readonly "TemplatePart": { readonly id?: string; readonly "name": string; readonly "area": string; };
}

export type GeneratedTemplateBlock = {
  readonly [Type in TemplateBlockType]: {
    readonly type: Type;
    readonly props: GeneratedTemplatePropsByType[Type];
  }
}[TemplateBlockType];

export interface GeneratedTemplateTree {
  readonly content: GeneratedTemplateBlock[];
}

export interface GeneratedChromePropsByType {
  readonly "ChromeLogo": { readonly id?: string; readonly "size"?: "sm" | "md" | "lg"; };
  readonly "ChromeSiteTitle": { readonly id?: string; readonly "showTagline"?: boolean; };
  readonly "ChromeNav": { readonly id?: string; readonly "location": "header" | "footer"; readonly "orientation": "horizontal" | "vertical"; };
  readonly "ChromeSearch": { readonly id?: string; readonly "placeholder"?: string; };
  readonly "ChromeSocials": { readonly id?: string; readonly "source": "settings"; };
  readonly "ChromeText": { readonly id?: string; readonly "text": string; };
  readonly "ChromeButton": { readonly id?: string; readonly "label": string; readonly "href": string; readonly "variant": "primary" | "ghost"; };
  readonly "ChromeSpacer": { readonly id?: string; readonly "size": "sm" | "md" | "lg"; };
  readonly "ChromeRow": { readonly id?: string; readonly "items": GeneratedChromeBlock[]; readonly "align": "start" | "center" | "end" | "between"; readonly "gap": "sm" | "md" | "lg"; readonly "wrap"?: boolean; };
}

export type GeneratedChromeBlock = {
  readonly [Type in ChromeBlockType]: {
    readonly type: Type;
    readonly props: GeneratedChromePropsByType[Type];
  }
}[ChromeBlockType];
