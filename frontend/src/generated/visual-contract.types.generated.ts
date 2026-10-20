/**
 * GENERATED TypeScript types from contracts/visual-contract.v1.json.
 * Do not edit. Run: npm run generate:f5
 */

export type VisualContractVersion = 1;
export type TemplateBlockType = "PageContent" | "Section" | "Grid" | "FlexRow" | "Columns" | "Spacer" | "Divider" | "PostsGrid" | "CategoryPosts" | "SearchBar" | "TemplatePart";
export type ChromeBlockType = "ChromeLogo" | "ChromeSiteTitle" | "ChromeNav" | "ChromeSearch" | "ChromeSocials" | "ChromeText" | "ChromeButton" | "ChromeSpacer" | "ChromeRow" | "ChromeColumns" | "ChromeHeading" | "ChromeRichText" | "ChromeCopyright" | "ChromeLanguageSwitcher" | "ChromeWidgets";
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
  readonly "ChromeLogo": { readonly id?: string; readonly "size"?: "sm" | "md" | "lg"; readonly "showTitle"?: boolean; readonly "hideMobile"?: boolean; readonly "hideTablet"?: boolean; readonly "hideDesktop"?: boolean; };
  readonly "ChromeSiteTitle": { readonly id?: string; readonly "showTagline"?: boolean; readonly "hideMobile"?: boolean; readonly "hideTablet"?: boolean; readonly "hideDesktop"?: boolean; };
  readonly "ChromeNav": { readonly id?: string; readonly "location": "header" | "footer"; readonly "orientation": "horizontal" | "vertical"; readonly "collapse"?: "mobile" | "tablet" | "always" | "never"; readonly "title"?: string; readonly "hideMobile"?: boolean; readonly "hideTablet"?: boolean; readonly "hideDesktop"?: boolean; };
  readonly "ChromeSearch": { readonly id?: string; readonly "placeholder"?: string; readonly "hideMobile"?: boolean; readonly "hideTablet"?: boolean; readonly "hideDesktop"?: boolean; };
  readonly "ChromeSocials": { readonly id?: string; readonly "source": "settings"; readonly "title"?: string; readonly "hideMobile"?: boolean; readonly "hideTablet"?: boolean; readonly "hideDesktop"?: boolean; };
  readonly "ChromeText": { readonly id?: string; readonly "text": string; readonly "hideMobile"?: boolean; readonly "hideTablet"?: boolean; readonly "hideDesktop"?: boolean; };
  readonly "ChromeButton": { readonly id?: string; readonly "label": string; readonly "href": string; readonly "variant": "primary" | "ghost"; readonly "hideMobile"?: boolean; readonly "hideTablet"?: boolean; readonly "hideDesktop"?: boolean; };
  readonly "ChromeSpacer": { readonly id?: string; readonly "size": "sm" | "md" | "lg"; readonly "hideMobile"?: boolean; readonly "hideTablet"?: boolean; readonly "hideDesktop"?: boolean; };
  readonly "ChromeRow": { readonly id?: string; readonly "items": GeneratedChromeBlock[]; readonly "align": "start" | "center" | "end" | "between"; readonly "gap": "sm" | "md" | "lg"; readonly "wrap"?: boolean; readonly "direction"?: "row" | "column"; readonly "stack"?: "never" | "mobile" | "tablet"; readonly "tone"?: "none" | "muted" | "primary" | "inverse"; readonly "hideMobile"?: boolean; readonly "hideTablet"?: boolean; readonly "hideDesktop"?: boolean; };
  readonly "ChromeColumns": { readonly id?: string; readonly "items": GeneratedChromeBlock[]; readonly "columns": "2" | "3" | "4" | "5"; readonly "gap": "sm" | "md" | "lg"; readonly "hideMobile"?: boolean; readonly "hideTablet"?: boolean; readonly "hideDesktop"?: boolean; };
  readonly "ChromeHeading": { readonly id?: string; readonly "text": string; readonly "level"?: "h2" | "h3" | "h4"; readonly "hideMobile"?: boolean; readonly "hideTablet"?: boolean; readonly "hideDesktop"?: boolean; };
  readonly "ChromeRichText": { readonly id?: string; readonly "html": string; readonly "hideMobile"?: boolean; readonly "hideTablet"?: boolean; readonly "hideDesktop"?: boolean; };
  readonly "ChromeCopyright": { readonly id?: string; readonly "text"?: string; readonly "hideMobile"?: boolean; readonly "hideTablet"?: boolean; readonly "hideDesktop"?: boolean; };
  readonly "ChromeLanguageSwitcher": { readonly id?: string; readonly "style"?: "inline" | "dropdown"; readonly "labels"?: "native" | "code"; readonly "hideMobile"?: boolean; readonly "hideTablet"?: boolean; readonly "hideDesktop"?: boolean; };
  readonly "ChromeWidgets": { readonly id?: string; readonly "area": string; readonly "hideMobile"?: boolean; readonly "hideTablet"?: boolean; readonly "hideDesktop"?: boolean; };
}

export type GeneratedChromeBlock = {
  readonly [Type in ChromeBlockType]: {
    readonly type: Type;
    readonly props: GeneratedChromePropsByType[Type];
  }
}[ChromeBlockType];
