/**
 * WordJS — el CLIENTE DE REDIS QUE PUBLICA EN EL BUS DE CLÚSTER no puede rendirse.
 *
 * `core/cache.ts` mantiene UN cliente que hace dos trabajos muy distintos:
 *   · caché de objetos — si Redis se cae, hay plan B: la BD;
 *   · PUBLICADOR del bus de clúster (invalidación coherente, notificaciones y el fan-out en tiempo
 *     real de la colaboración) — y aquí NO HAY PLAN B.
 *
 * Su política de reconexión devolvía `null` tras 3 intentos, que es como se le dice a ioredis «deja
 * de reconectar PARA SIEMPRE». El log lo contaba como algo benigno («Falling back to DB»), y lo era
 * para la caché; para el bus significaba que un parpadeo de Redis dejaba el tiempo real ENTRE NODOS
 * muerto hasta reiniciar el proceso.
 *
 * Reproducido en el laboratorio multinodo (dos backends contra el mismo Postgres y el mismo Redis):
 * parar Redis 4 s y volver a arrancarlo dejaba el fan-out roto de forma PERMANENTE — el editor del
 * nodo B no volvió a recibir ni una operación del nodo A, y `⚡ Redis Object Cache Connected` salió
 * UNA sola vez, la del arranque. Con la política de aquí, la reconexión se recupera sola.
 *
 * Esto NO necesita un Redis vivo: la política es una función pura del número de intento, y lo que
 * se fija es su contrato — nunca rendirse, y esperar un tiempo acotado.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const cache = require('../core/cache');

describe('bus de clúster: la política de reconexión no puede rendirse', () => {
    test('nunca devuelve `null` (que es como ioredis entiende «no reconectes más»)', () => {
        const retry = cache._busRetryStrategy;
        assert.equal(typeof retry, 'function', 'la política tiene que estar expuesta para poder fijarla');

        const realWarn = console.warn;
        console.warn = () => { /* la política avisa una vez; aquí solo interesa el valor */ };
        try {
            // El defecto vivía en el intento 4: `if (times > 3) return null`.
            for (const times of [1, 2, 3, 4, 5, 10, 100, 10_000]) {
                const espera = retry(times);
                assert.equal(typeof espera, 'number',
                    `intento ${times}: la política devolvió ${JSON.stringify(espera)}; cualquier cosa que no ` +
                    'sea un número hace que ioredis deje de reconectar y mata el bus hasta reiniciar');
                assert.ok(Number.isFinite(espera) && espera > 0,
                    `intento ${times}: la espera tiene que ser un número finito y positivo, no ${espera}`);
            }
        } finally {
            console.warn = realWarn;
        }
    });

    test('la espera está ACOTADA: un corte largo no se convierte en una reconexión que no llega', () => {
        const retry = cache._busRetryStrategy;
        const realWarn = console.warn;
        console.warn = () => { /* silencio */ };
        try {
            for (const times of [50, 500, 5000]) {
                assert.ok(retry(times) <= 3000,
                    `intento ${times}: la espera no puede crecer sin límite o el nodo tarda horas en volver al bus`);
            }
        } finally {
            console.warn = realWarn;
        }
    });

    test('avisa de que lo DEGRADADO es el BUS, no solo la caché', () => {
        // El mensaje viejo decía «Falling back to DB», que es verdad para la caché y FALSO para el
        // bus: quien lo leía en un multinodo se quedaba tranquilo mientras el tiempo real entre
        // nodos estaba muerto. El aviso tiene que nombrar lo que de verdad se ha roto.
        const retry = cache._busRetryStrategy;
        const realWarn = console.warn;
        const avisos: string[] = [];
        console.warn = (...a: any[]) => { avisos.push(a.join(' ')); };
        try {
            for (let i = 1; i <= 8; i++) retry(i);
        } finally {
            console.warn = realWarn;
        }
        assert.equal(avisos.length, 1, `el aviso se emite UNA vez por corte, no en cada intento: ${avisos.length}`);
        assert.match(avisos[0], /CLUSTER BUS/,
            `el aviso tiene que decir que lo degradado es el bus de clúster: ${JSON.stringify(avisos)}`);
        assert.match(avisos[0], /DEGRADED/, `y que está DEGRADADO: ${JSON.stringify(avisos)}`);
    });

    test('`redisConfigured` se expone: «¿hay clúster?» no es «¿está levantado?»', () => {
        // `pubsubAvailable()` es `redisConfigured() && redisAvailable`, así que NO sirve para
        // distinguir un monolito (nada que entregar fuera) de un multinodo con el bus caído (la
        // entrega acaba de fallar). Quien tenga que decidir si una pérdida hay que registrarla
        // necesita la pregunta por la CONFIGURACIÓN — ver core/collab-rooms.ts#broadcast.
        assert.equal(typeof cache.redisConfigured, 'function',
            'sin esta pregunta, «bus caído» y «bus ausente» se confunden y la pérdida se vuelve invisible');
        assert.equal(typeof cache.redisConfigured(), 'boolean');
    });
});
