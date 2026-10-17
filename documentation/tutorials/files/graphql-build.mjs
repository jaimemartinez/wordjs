// graphql-build.mjs: write a static index.html listing the site's latest posts, read over GraphQL.
// Usage: WORDJS_URL=https://www.example.com node graphql-build.mjs
import { writeFile } from 'node:fs/promises';

const SITE = process.env.WORDJS_URL || 'http://localhost:3000';

async function graphql(query, variables = {}) {
  const url = new URL('/api/v1/graphql', SITE);
  url.searchParams.set('query', query);
  url.searchParams.set('variables', JSON.stringify(variables));
  const res = await fetch(url); // GET: no cookie, no CSRF token needed
  const body = await res.json();
  if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data;
}

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const posts = [];
let after = null;
do {
  const { posts: page } = await graphql(
    `query Latest($after: String) {
       posts(first: 10, after: $after) {
         pageInfo { hasNextPage endCursor }
         nodes { title link date excerpt author { name } }
       }
     }`,
    { after },
  );
  posts.push(...page.nodes);
  after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
} while (after && posts.length < 50);

const { settings } = await graphql('{ settings { title description } }');

const html = `<!doctype html>
<meta charset="utf-8">
<title>${escape(settings.title)}</title>
<h1>${escape(settings.title)}</h1>
<ul>
${posts.map((p) => `  <li><a href="${escape(p.link)}">${escape(p.title)}</a> · ${escape(p.author?.name)} · ${escape(p.date.slice(0, 10))}</li>`).join('\n')}
</ul>
`;
await writeFile('index.html', html);
console.log(`Wrote index.html with ${posts.length} posts from ${SITE}`);
