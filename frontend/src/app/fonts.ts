import { Inter } from "next/font/google";

// Single shared next/font instance. `variable` exposes the real (hashed) family through
// --font-inter — next/font registers the face as "__Inter_<hash>", never the literal "Inter",
// so stylesheets must reference var(--font-inter), not the name. The root layout puts ONLY
// `inter.variable` on <body>: the public tree resolves its type through the wordjs-ui.css body
// rule (whose --wjs-font-family-base defaults to var(--font-inter, …)), while each non-(public)
// tree (admin, login, install, migration, reset-password, portal) opts back into
// `inter.className` in its own layout.
export const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
