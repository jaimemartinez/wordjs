const { init, dbAsync } = require('../src/config/database');

async function createDemoPage() {
    await init();
    console.log('🚀 Updating Demo Visual page with Advanced Puck Elements...');

    const title = 'Exploración de Identidad Visual';
    const slug = 'test-visual';
    const postType = 'page';
    const postStatus = 'publish';
    const authorId = 1;

    const puckData = {
        content: [
            {
                type: 'Heading',
                props: { title: 'Identidad Visual WordJS', level: 'h1', id: 'heading-1' }
            },
            {
                type: 'Text',
                props: {
                    content: '<p>Los temas de WordJS no solo cambian colores, sino que redefinen la forma en que los elementos interactúan con el usuario. Abajo verás componentes avanzados que cambian drásticamente entre temas.</p>',
                    id: 'text-1'
                }
            },
            {
                type: 'Divider',
                props: { type: 'gradient', id: 'divider-1' }
            },
            {
                type: 'Card',
                props: {
                    title: 'Diseño Adaptativo',
                    description: 'Nuestros componentes se adaptan no solo al tamaño de la pantalla, sino al espíritu del tema activo.',
                    icon: 'fa-wand-magic-sparkles',
                    theme: 'accent',
                    id: 'card-1'
                }
            },
            {
                type: 'Spacer',
                props: { css: { height: '40px' }, id: 'spacer-1' }
            },
            {
                type: 'Button',
                props: {
                    label: 'Ver Documentación',
                    href: '#',
                    variant: 'primary',
                    align: 'center',
                    id: 'button-1'
                }
            }
        ],
        root: {
            props: { title: title, slug: slug }
        }
    };

    const htmlContent = `
        <h1 class="wp-block-heading font-bold text-4xl my-4">Identidad Visual WordJS</h1>
        <div class="wp-block-text prose">
            <p>Los temas de WordJS no solo cambian colores, sino que redefinen la forma en que los elementos interactúan con el usuario. Abajo verás componentes avanzados que cambian drásticamente entre temas.</p>
        </div>
        <hr class="wp-block-divider divider-gradient my-10 border-gray-100" />
        <div class="wp-block-card card-theme-accent p-8 rounded-3xl border my-6">
            <i class="fa-solid fa-wand-magic-sparkles text-2xl mb-4"></i>
            <h3 class="text-xl font-bold mb-2">Diseño Adaptativo</h3>
            <p class="opacity-80">Nuestros componentes se adaptan no solo al tamaño de la pantalla, sino al espíritu del tema activo.</p>
        </div>
        <div style="height: 40px"></div>
        <div class="wp-block-button my-6 text-center">
            <a href="#" class="wp-button button-primary bg-blue-600 text-white px-8 py-3 rounded-full font-bold">Ver Documentación</a>
        </div>
    `;

    try {
        const existing = await dbAsync.get('SELECT id FROM posts WHERE post_name = ?', [slug]);

        let postId;
        if (existing) {
            console.log('📝 Updating existing demo page...');
            await dbAsync.run(
                'UPDATE posts SET post_title = ?, post_content = ?, post_status = ? WHERE id = ?',
                [title, htmlContent, postStatus, existing.id]
            );
            postId = existing.id;
        } else {
            console.log('✨ Inserting new demo page...');
            const result = await dbAsync.run(
                "INSERT INTO posts (author_id, post_date, post_date_gmt, post_content, post_title, post_status, post_name, post_type, comment_status, post_excerpt) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, 'open', '')",
                [authorId, htmlContent, title, postStatus, slug, postType]
            );
            postId = result.lastID;
        }

        await dbAsync.run('DELETE FROM post_meta WHERE post_id = ? AND meta_key = ?', [postId, '_puck_data']);
        await dbAsync.run(
            'INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
            [postId, '_puck_data', JSON.stringify(puckData)]
        );

        console.log(`✅ Demo page updated successfully!`);
    } catch (err) {
        console.error('❌ Error creating demo page:', err);
    }
}

createDemoPage().then(() => process.exit());
