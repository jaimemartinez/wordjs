/**
 * GENERATED backend validator data from contracts/visual-contract.v1.json.
 * Do not edit. Run: npm run generate:f5
 */

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export const VISUAL_CONTRACT_VERSION = 1 as const;
export const TEMPLATE_CONTRACT = deepFreeze({
  "version": 1,
  "root": "content",
  "contentSlot": "PageContent",
  "limits": {
    "maxBytes": 65536,
    "maxBlocks": 100,
    "maxDepth": 4
  },
  "wrapperTags": [
    "article",
    "aside",
    "div",
    "footer",
    "header",
    "section"
  ],
  "classList": {
    "tokenPattern": "^[a-z][a-z0-9-]{0,39}$",
    "maxTokens": 3
  },
  "blocks": {
    "PageContent": {
      "slot": null,
      "props": {}
    },
    "Section": {
      "slot": "items",
      "props": {
        "background": {
          "kind": "string"
        },
        "padding": {
          "kind": "string"
        },
        "maxWidth": {
          "kind": "string"
        },
        "tag": {
          "kind": "wrapper-tag"
        },
        "className": {
          "kind": "classlist"
        }
      }
    },
    "Grid": {
      "slot": "items",
      "props": {
        "columns": {
          "kind": "number"
        },
        "gap": {
          "kind": "string"
        },
        "columnsTablet": {
          "kind": "number"
        },
        "columnsMobile": {
          "kind": "number"
        },
        "tag": {
          "kind": "wrapper-tag"
        },
        "className": {
          "kind": "classlist"
        }
      }
    },
    "FlexRow": {
      "slot": "items",
      "props": {
        "gap": {
          "kind": "string"
        },
        "align": {
          "kind": "enum",
          "values": [
            "start",
            "center",
            "end",
            "stretch"
          ]
        },
        "justify": {
          "kind": "enum",
          "values": [
            "start",
            "center",
            "end",
            "between",
            "around"
          ]
        },
        "wrap": {
          "kind": "boolean"
        },
        "direction": {
          "kind": "enum",
          "values": [
            "row",
            "column",
            "row-reverse",
            "column-reverse"
          ]
        },
        "tag": {
          "kind": "wrapper-tag"
        },
        "className": {
          "kind": "classlist"
        }
      }
    },
    "Columns": {
      "slot": "items",
      "props": {
        "columns": {
          "kind": "number"
        },
        "gap": {
          "kind": "string"
        },
        "tag": {
          "kind": "wrapper-tag"
        },
        "className": {
          "kind": "classlist"
        }
      }
    },
    "Spacer": {
      "slot": null,
      "props": {
        "height": {
          "kind": "string"
        }
      }
    },
    "Divider": {
      "slot": null,
      "props": {
        "color": {
          "kind": "string"
        },
        "width": {
          "kind": "string"
        },
        "length": {
          "kind": "string"
        },
        "gap": {
          "kind": "string"
        }
      }
    },
    "PostsGrid": {
      "slot": null,
      "props": {
        "count": {
          "kind": "number"
        },
        "columns": {
          "kind": "number"
        },
        "gap": {
          "kind": "string"
        },
        "bg": {
          "kind": "string"
        },
        "borderColor": {
          "kind": "string"
        },
        "radius": {
          "kind": "string"
        },
        "pad": {
          "kind": "string"
        },
        "thumbHeight": {
          "kind": "string"
        }
      }
    },
    "CategoryPosts": {
      "slot": null,
      "props": {
        "count": {
          "kind": "number"
        },
        "categorySlug": {
          "kind": "string"
        },
        "layout": {
          "kind": "enum",
          "values": [
            "grid",
            "list"
          ]
        },
        "columns": {
          "kind": "number"
        },
        "gap": {
          "kind": "string"
        },
        "bg": {
          "kind": "string"
        },
        "borderColor": {
          "kind": "string"
        },
        "radius": {
          "kind": "string"
        },
        "linkColor": {
          "kind": "string"
        },
        "headingColor": {
          "kind": "string"
        }
      }
    },
    "SearchBar": {
      "slot": null,
      "props": {
        "placeholder": {
          "kind": "string"
        },
        "buttonText": {
          "kind": "string"
        },
        "align": {
          "kind": "enum",
          "values": [
            "left",
            "center",
            "right"
          ]
        },
        "width": {
          "kind": "string"
        },
        "inputBg": {
          "kind": "string"
        },
        "inputBorderColor": {
          "kind": "string"
        },
        "inputRadius": {
          "kind": "string"
        },
        "buttonBg": {
          "kind": "string"
        },
        "buttonColor": {
          "kind": "string"
        },
        "buttonRadius": {
          "kind": "string"
        }
      }
    },
    "TemplatePart": {
      "slot": null,
      "required": [
        "name",
        "area"
      ],
      "props": {
        "name": {
          "kind": "partname"
        },
        "area": {
          "kind": "template-part-area"
        }
      }
    }
  },
  "forbiddenBlocks": {
    "HTMLEmbed": "raw HTML in a theme-shipped template is an injection surface — the page body is the place for it",
    "Symbol": "a Symbol resolves to stored content a theme cannot see at validation time",
    "Form": "a form needs a per-site configuration a theme cannot carry",
    "Heading": "a template arranges the page; the page supplies its own headings",
    "Text": "a template arranges the page; the page supplies its own copy",
    "Image": "a template must not ship page imagery — use the page content or a token-driven background"
  }
} as const);
export const CHROME_CONTRACT = deepFreeze({
  "version": 1,
  "limits": {
    "maxBytes": 65536,
    "maxBlocks": 100,
    "maxDepth": 3
  },
  "siteParts": [
    "header",
    "footer"
  ],
  "announcementPart": "announcement",
  "documentScopedBlocks": {
    "ChromeNav": "it mounts the mobile drawer, which owns document.body scroll-lock, a document keydown listener and a portal into document.body — two instances on one page fight over that single global"
  },
  "blocks": {
    "ChromeLogo": {
      "props": {
        "size": {
          "kind": "enum",
          "values": [
            "sm",
            "md",
            "lg"
          ]
        }
      }
    },
    "ChromeSiteTitle": {
      "props": {
        "showTagline": {
          "kind": "boolean"
        }
      }
    },
    "ChromeNav": {
      "props": {
        "location": {
          "kind": "enum",
          "values": [
            "header",
            "footer"
          ],
          "required": true
        },
        "orientation": {
          "kind": "enum",
          "values": [
            "horizontal",
            "vertical"
          ],
          "required": true
        }
      }
    },
    "ChromeSearch": {
      "props": {
        "placeholder": {
          "kind": "string"
        }
      }
    },
    "ChromeSocials": {
      "props": {
        "source": {
          "kind": "enum",
          "values": [
            "settings"
          ],
          "required": true
        }
      }
    },
    "ChromeText": {
      "props": {
        "text": {
          "kind": "string",
          "required": true,
          "sanitize": "plain-text"
        }
      }
    },
    "ChromeButton": {
      "props": {
        "label": {
          "kind": "string",
          "required": true,
          "sanitize": "plain-text"
        },
        "href": {
          "kind": "href",
          "required": true,
          "sanitize": "navigation-url"
        },
        "variant": {
          "kind": "enum",
          "values": [
            "primary",
            "ghost"
          ],
          "required": true
        }
      }
    },
    "ChromeSpacer": {
      "props": {
        "size": {
          "kind": "enum",
          "values": [
            "sm",
            "md",
            "lg"
          ],
          "required": true
        }
      }
    },
    "ChromeRow": {
      "props": {
        "items": {
          "kind": "slot",
          "required": true
        },
        "align": {
          "kind": "enum",
          "values": [
            "start",
            "center",
            "end",
            "between"
          ],
          "required": true
        },
        "gap": {
          "kind": "enum",
          "values": [
            "sm",
            "md",
            "lg"
          ],
          "required": true
        },
        "wrap": {
          "kind": "boolean"
        }
      }
    }
  }
} as const);
export const THEME_CONTRACT = deepFreeze({
  "slugPattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",
  "assetNamePattern": "^[a-z0-9-]{1,40}$",
  "tokens": {
    "namePattern": "^--wjs-[a-zA-Z0-9_-]+$",
    "modNamePattern": "^--wjs-[a-z0-9-]+$",
    "valuePattern": "^[#a-zA-Z0-9 ,.%()/_'\"-]+$",
    "maxValueLength": 120,
    "maxModsBytes": 32768,
    "forbiddenFunctionPattern": "url\\s*\\(",
    "forbiddenSubstrings": [
      "//",
      "\\"
    ]
  },
  "templateParts": {
    "areas": [
      "header",
      "footer",
      "sidebar",
      "general"
    ],
    "areaWrappers": {
      "header": "header",
      "footer": "footer",
      "sidebar": "aside",
      "general": "div"
    },
    "maxItems": 16,
    "keys": [
      "name",
      "area"
    ]
  }
} as const);
export const PROPERTY_SANITIZERS = deepFreeze({
  "richText": [
    "content",
    "html",
    "text",
    "title",
    "heading",
    "description",
    "caption",
    "body"
  ],
  "url": [
    "url",
    "src",
    "href",
    "link",
    "image",
    "poster"
  ]
} as const);
export const HTML_SANITIZATION = deepFreeze({
  "allowedTags": [
    "p",
    "br",
    "b",
    "i",
    "u",
    "strong",
    "em",
    "mark",
    "s",
    "del",
    "ins",
    "sub",
    "sup",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "a",
    "img",
    "figure",
    "figcaption",
    "video",
    "audio",
    "source",
    "iframe",
    "div",
    "span",
    "section",
    "article",
    "header",
    "footer",
    "nav",
    "aside",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "caption",
    "form",
    "input",
    "button",
    "select",
    "option",
    "textarea",
    "label",
    "blockquote",
    "pre",
    "code",
    "hr",
    "details",
    "summary"
  ],
  "allowedAttributes": [
    "id",
    "class",
    "title",
    "lang",
    "dir",
    "style",
    "href",
    "target",
    "rel",
    "src",
    "alt",
    "width",
    "height",
    "loading",
    "controls",
    "autoplay",
    "muted",
    "loop",
    "poster",
    "colspan",
    "rowspan",
    "type",
    "name",
    "value",
    "placeholder",
    "disabled",
    "readonly",
    "checked",
    "frameborder",
    "allow",
    "allowfullscreen",
    "referrerpolicy",
    "sandbox",
    "data-*"
  ],
  "forbiddenTags": [
    "script",
    "object",
    "embed",
    "base",
    "meta",
    "link"
  ],
  "forbiddenAttributes": [
    "onerror",
    "onload",
    "onclick",
    "onmouseover",
    "onfocus",
    "onblur"
  ],
  "iframeHosts": [
    "www.youtube.com",
    "player.vimeo.com",
    "www.youtube-nocookie.com"
  ],
  "videoProviders": {
    "youtube": {
      "standardHosts": [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com"
      ],
      "noCookieHosts": [
        "youtube-nocookie.com",
        "www.youtube-nocookie.com"
      ],
      "shortHosts": [
        "youtu.be",
        "www.youtu.be"
      ],
      "outputHost": "www.youtube.com",
      "noCookieOutputHost": "www.youtube-nocookie.com",
      "idPathSegments": [
        "embed",
        "shorts",
        "v",
        "live"
      ]
    },
    "vimeo": {
      "pageHosts": [
        "vimeo.com",
        "www.vimeo.com"
      ],
      "outputHost": "player.vimeo.com"
    }
  },
  "iframeSandbox": "allow-scripts allow-same-origin allow-presentation",
  "inlineStyleProperties": [
    "color",
    "background-color",
    "font-size",
    "font-family",
    "font-weight",
    "font-style",
    "text-decoration",
    "text-align",
    "line-height",
    "text-transform"
  ],
  "inlineStyleValuePatterns": {
    "color": [
      "^#(?:[0-9a-fA-F]{3,8})$",
      "^rgb\\(",
      "^rgba\\(",
      "^hsl\\(",
      "^hsla\\(",
      "^[a-zA-Z]+$"
    ],
    "background-color": [
      "^#(?:[0-9a-fA-F]{3,8})$",
      "^rgb\\(",
      "^rgba\\(",
      "^hsl\\(",
      "^hsla\\(",
      "^[a-zA-Z]+$"
    ],
    "font-size": [
      "^\\d+(?:\\.\\d+)?(?:px|em|rem|%|pt)$"
    ],
    "font-family": [
      "^[\\w\\s,'\"()-]+$"
    ],
    "font-weight": [
      "^(?:normal|bold|bolder|lighter|[1-9]00)$"
    ],
    "font-style": [
      "^(?:normal|italic|oblique)$"
    ],
    "text-decoration": [
      "^(?:none|underline|line-through|overline)(?:\\s+\\w+)*$"
    ],
    "text-align": [
      "^(?:left|right|center|justify)$"
    ],
    "line-height": [
      "^[\\d.]+(?:px|em|rem|%)?$"
    ],
    "text-transform": [
      "^(?:none|uppercase|lowercase|capitalize)$"
    ]
  }
} as const);
export const URL_SANITIZATION = deepFreeze({
  "navigationSchemes": [
    "http",
    "https"
  ],
  "contentSchemes": [
    "http",
    "https",
    "mailto",
    "tel"
  ],
  "mediaSchemes": [
    "http",
    "https",
    "data"
  ],
  "blockedPuckSchemes": [
    "javascript",
    "data",
    "vbscript",
    "file"
  ],
  "stripControlsPattern": "[\\t\\n\\r]"
} as const);
export const STYLE_SECURITY = deepFreeze({
  "authorProperties": [
    "display",
    "flexDirection",
    "justifyContent",
    "alignItems",
    "gap",
    "flexWrap",
    "width",
    "height",
    "minHeight",
    "padding",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "margin",
    "marginTop",
    "marginRight",
    "marginBottom",
    "marginLeft",
    "fontFamily",
    "color",
    "fontSize",
    "fontWeight",
    "textAlign",
    "lineHeight",
    "letterSpacing",
    "textTransform",
    "textDecoration",
    "backgroundColor",
    "backgroundImage",
    "backgroundSize",
    "backgroundPosition",
    "border",
    "borderWidth",
    "borderColor",
    "borderStyle",
    "borderRadius",
    "boxShadow",
    "opacity",
    "overflow"
  ],
  "authorCustomProperties": [
    "--wjs-text-color",
    "--wjs-heading-color"
  ],
  "reviewedVariableDeclarations": [
    "background",
    "border-top",
    "border-bottom",
    "border-inline-start",
    "border-bottom-color",
    "border-bottom-width",
    "font-style",
    "grid-template-columns",
    "max-width",
    "object-fit"
  ],
  "forbiddenPositionKeywords": [
    "static",
    "relative",
    "absolute",
    "fixed",
    "sticky"
  ],
  "positionBindingClasses": [
    "alert-dismissible",
    "btn-close",
    "cf-field-num",
    "cf-lightbox",
    "cf-lightbox-count",
    "cf-lightbox-nav",
    "cf-overlay",
    "cf-preview-banner",
    "cf-preview-close",
    "cf-switch",
    "cf-switch-knob",
    "cf-visually-hidden",
    "close",
    "dropdown-menu",
    "modal",
    "modal-backdrop",
    "plugin-admin-announcement",
    "plugin-admin-auctions",
    "plugin-admin-bookings",
    "plugin-admin-contact-forms",
    "plugin-admin-cookie-consent",
    "plugin-admin-donations",
    "plugin-admin-downloads",
    "plugin-admin-events-calendar",
    "plugin-admin-faq",
    "plugin-admin-invoices",
    "plugin-admin-jobs",
    "plugin-admin-lightbox",
    "plugin-admin-newsletter",
    "plugin-admin-polls",
    "plugin-admin-popups",
    "plugin-admin-restaurant",
    "plugin-admin-share",
    "plugin-admin-store",
    "plugin-admin-testimonials",
    "plugin-admin-tickets",
    "plugin-admin-tracking",
    "plugin-admin-vendor-marketplace",
    "plugin-admin-youtube",
    "position-absolute",
    "position-fixed",
    "position-sticky",
    "promo-card-bg",
    "promo-card-overlay",
    "ratio",
    "show",
    "verso-icon-button",
    "verso-overlay-scrim",
    "verso-rail-button",
    "verso-sheet",
    "verso-sheet-scrim",
    "verso-skip-link",
    "video-scroll-arrow",
    "visually-hidden",
    "wjcc-banner",
    "wjnb-bar",
    "wjnb-close",
    "wjpb-close",
    "wjpb-overlay",
    "wjs-block-hero-overlay",
    "wjs-block-hero__overlay",
    "wjs-block-particle-field",
    "wjs-block-section__stage",
    "wjs-block-testimonial__mark",
    "wjs-block-video-embed",
    "wjs-block-video-embed__chip",
    "wjs-block-video-embed__cover",
    "wjs-block-video-embed__placeholder",
    "wjs-block-video-embed__scrim",
    "wjs-header-nav",
    "wjs-ilb-btn",
    "wjs-ilb-counter",
    "wjs-ilb-overlay",
    "wjs-motion-pause__input",
    "wjs-public-site",
    "wjs-site-header"
  ],
  "ownBlockPrefix": "wjs-block-",
  "legacyBlockPrefix": "wp-block-",
  "maxClassAttributeToken": 64,
  "maxClassTokenTail": 48,
  "transformPolicy": {
    "maxFunctions": 4,
    "scale": {
      "min": 0.5,
      "max": 1.5
    },
    "translateMax": {
      "px": 100,
      "%": 100,
      "rem": 8,
      "em": 8
    }
  },
  "narrowedVariables": {
    "--wjs-pricing-highlight-scale": {
      "kind": "number",
      "min": 0.5,
      "max": 1.5
    },
    "--wjs-scroll-amt": {
      "kind": "number",
      "min": -200,
      "max": 200
    },
    "--wjs-card-hover-transform": {
      "kind": "transform"
    },
    "--wjs-button-hover-transform": {
      "kind": "transform"
    },
    "--wjs-button-active-transform": {
      "kind": "transform"
    },
    "--wjs-accordion-icon-open-transform": {
      "kind": "transform"
    },
    "--wjs-video-play-glyph-transform": {
      "kind": "transform"
    },
    "--wjs-video-play-hover-transform": {
      "kind": "transform"
    },
    "--wjs-audio-icon-hover-transform": {
      "kind": "transform"
    },
    "--wjs-audio-icon-active-transform": {
      "kind": "transform"
    },
    "--wjs-pricing-hover-transform": {
      "kind": "transform"
    },
    "--wjs-pricing-highlight-hover-transform": {
      "kind": "transform"
    },
    "--wjs-pricing-highlight-mobile-transform": {
      "kind": "transform"
    },
    "--wjs-pricing-highlight-mobile-hover-transform": {
      "kind": "transform"
    },
    "--wjs-cta-button-hover-transform": {
      "kind": "transform"
    },
    "--wjs-posts-hover-transform": {
      "kind": "transform"
    },
    "--wjs-hero-button-hover-transform": {
      "kind": "transform"
    },
    "--wjs-social-hover-transform": {
      "kind": "transform"
    },
    "--wjs-audio-marquee-gap": {
      "kind": "length",
      "max": {
        "px": 400,
        "%": 100,
        "rem": 25,
        "em": 25,
        "vw": 100,
        "vh": 100
      }
    },
    "--wjs-xl": {
      "kind": "length",
      "max": {
        "px": 400,
        "%": 100,
        "rem": 25,
        "em": 25,
        "vw": 100,
        "vh": 100
      }
    },
    "--wjs-target-size": {
      "kind": "non-negative-length",
      "max": {
        "px": 96,
        "rem": 6,
        "em": 6
      }
    }
  },
  "unsafeValuePattern": "url\\(|image-set\\(|expression|javascript:|[;{}<>\\\\@]",
  "urlBearingPropertyPattern": "^backgroundImage$|-image$"
} as const);
