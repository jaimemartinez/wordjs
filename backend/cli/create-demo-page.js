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
                type: 'Hero',
                props: {
                    title: 'WordJS Luminous Architecture',
                    subtitle: 'Experiencias de contenido visuales construidas con arquitectura atómica, rendimiento extremo e identidad visual adaptable.',
                    align: 'center',
                    height: '60vh',
                    buttons: [
                        { label: 'Empezar ahora', href: '#', variant: 'primary' },
                        { label: 'Documentación', href: '#', variant: 'outline' }
                    ],
                    id: 'hero-1'
                }
            },
            {
                type: 'Stats',
                props: {
                    items: [
                        { value: '240ms', label: 'Carga Promedio' },
                        { value: '99.9%', label: 'Disponibilidad' },
                        { value: '100%', label: 'Basado en Tokens' }
                    ],
                    id: 'stats-1'
                }
            },
            {
                type: 'Spacer',
                props: { css: { height: '32px' }, id: 'spacer-1' }
            },
            {
                type: 'Heading',
                props: { title: 'Librería de Componentes Stitch', level: 'h2', id: 'heading-1' }
            },
            {
                type: 'Text',
                props: {
                    content: '<p>Los componentes de WordJS se adaptan automáticamente a las reglas del tema activo a través del contrato de tokens <code>--wjs-*</code>.</p>',
                    id: 'text-1'
                }
            },
            {
                type: 'Card',
                props: {
                    title: 'Diseño Adaptativo Atómico',
                    description: 'Nuestros componentes se adaptan no solo al tamaño de la pantalla, sino a la identidad visual del tema activo.',
                    icon: 'fa-wand-magic-sparkles',
                    theme: 'accent',
                    id: 'card-1'
                }
            },
            {
                type: 'PricingTable',
                props: {
                    plans: [
                        { name: 'Starter', price: '$0', period: '/mes', features: '3 Proyectos\nBloques Estándar\nSoporte Comunidad', highlighted: 'false', buttonText: 'Comenzar Gratis', buttonLink: '#' },
                        { name: 'Professional', price: '$29', period: '/mes', features: 'Proyectos Ilimitados\nTodos los Bloques Stitch\nPersonalizador de Temas\nSoporte Prioritario', highlighted: 'true', buttonText: 'Probar 14 Días', buttonLink: '#' },
                        { name: 'Enterprise', price: '$99', period: '/mes', features: 'Infraestructura Aislada\nPlugins Sandbox OS\nSLA 99.99%\nSoporte Dedicado 24/7', highlighted: 'false', buttonText: 'Contactar Ventas', buttonLink: '#' }
                    ],
                    id: 'pricing-1'
                }
            },
            {
                type: 'Testimonial',
                props: {
                    quote: 'La precisión del sistema de bloques de WordJS transformó la interacción de nuestro equipo con el CMS. Es un instrumento de alta precisión.',
                    author: 'Elena Korova',
                    role: 'Lead Product Designer',
                    id: 'testimonial-1'
                }
            },
            {
                type: 'CTABanner',
                props: {
                    title: '¿Listo para construir el futuro?',
                    subtitle: 'Únete a miles de creadores construyendo experiencias web modernas con WordJS.',
                    buttonText: 'Comenzar Ahora',
                    buttonLink: '#',
                    variant: 'primary',
                    id: 'cta-1'
                }
            }
        ],
        root: {
            props: { title: title, slug: slug }
        }
    };

    const htmlContent = `
        <div class="wp-block-hero">
            <div class="wp-block-hero__inner">
                <h1 class="wp-block-hero__title">WordJS Luminous Architecture</h1>
                <p class="wp-block-hero__subtitle">Experiencias de contenido visuales construidas con arquitectura atómica, rendimiento extremo e identidad visual adaptable.</p>
                <div class="wp-block-hero__actions">
                    <a href="#" class="wp-block-hero__button">Empezar ahora</a>
                    <a href="#" class="wp-block-hero__button wp-block-hero__button--outline">Documentación</a>
                </div>
            </div>
        </div>
        <div class="wp-block-stats my-10">
            <div class="wp-block-stats__item">
                <div class="wp-block-stats__value">240ms</div>
                <div class="wp-block-stats__label">Carga Promedio</div>
            </div>
            <div class="wp-block-stats__item">
                <div class="wp-block-stats__value">99.9%</div>
                <div class="wp-block-stats__label">Disponibilidad</div>
            </div>
            <div class="wp-block-stats__item">
                <div class="wp-block-stats__value">100%</div>
                <div class="wp-block-stats__label">Basado en Tokens</div>
            </div>
        </div>
        <h2 class="wp-block-heading font-bold text-3xl my-6">Librería de Componentes Stitch</h2>
        <div class="wp-block-text prose mb-6">
            <p>Los componentes de WordJS se adaptan automáticamente a las reglas del tema activo a través del contrato de tokens <code>--wjs-*</code>.</p>
        </div>
        <div class="wp-block-card card-theme-accent p-8 rounded-3xl border my-6">
            <i class="fa-solid fa-wand-magic-sparkles text-2xl mb-4"></i>
            <h3 class="text-xl font-bold mb-2">Diseño Adaptativo Atómico</h3>
            <p class="opacity-80">Nuestros componentes se adaptan no solo al tamaño de la pantalla, sino a la identidad visual del tema activo.</p>
        </div>
        <div class="wp-block-pricing my-12">
            <div class="wp-block-pricing__plan">
                <h3 class="wp-block-pricing__name">Starter</h3>
                <div class="wp-block-pricing__price">$0<span class="wp-block-pricing__period">/mes</span></div>
                <ul class="wp-block-pricing__features">
                    <li class="wp-block-pricing__feature"><i class="fa-solid fa-check"></i>3 Proyectos</li>
                    <li class="wp-block-pricing__feature"><i class="fa-solid fa-check"></i>Bloques Estándar</li>
                </ul>
                <a href="#" class="wp-block-pricing__button">Comenzar Gratis</a>
            </div>
            <div class="wp-block-pricing__plan wp-block-pricing__plan--highlighted">
                <h3 class="wp-block-pricing__name">Professional</h3>
                <div class="wp-block-pricing__price">$29<span class="wp-block-pricing__period">/mes</span></div>
                <ul class="wp-block-pricing__features">
                    <li class="wp-block-pricing__feature"><i class="fa-solid fa-check"></i>Proyectos Ilimitados</li>
                    <li class="wp-block-pricing__feature"><i class="fa-solid fa-check"></i>Todos los Bloques Stitch</li>
                </ul>
                <a href="#" class="wp-block-pricing__button">Probar 14 Días</a>
            </div>
        </div>
        <div class="wp-block-testimonial my-8">
            <div class="wp-block-testimonial__quote">"La precisión del sistema de bloques de WordJS transformó la interacción de nuestro equipo con el CMS."</div>
            <div class="wp-block-testimonial__author">Elena Korova</div>
            <div class="wp-block-testimonial__role">Lead Product Designer</div>
        </div>
        <div class="wp-block-cta-banner my-10">
            <h2 class="wp-block-cta-banner__title">¿Listo para construir el futuro?</h2>
            <p class="wp-block-cta-banner__subtitle">Únete a miles de creadores construyendo experiencias web modernas con WordJS.</p>
            <a href="#" class="wp-block-cta-banner__button">Comenzar Ahora</a>
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
