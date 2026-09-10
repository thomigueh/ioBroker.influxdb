const assert = require('node:assert');
const http = require('node:http');

const {
    escapeLineProtocolMeasurement,
    escapeLineProtocolTagKey,
    escapeLineProtocolString,
    formatLineProtocolFieldValue,
    stateValueToLineProtocol,
    seriesToLineProtocol,
    escapeSqlIdentifier,
    escapeSqlString,
    tableNameForId,
} = require('../build/lib/lineProtocol');
const DatabaseInfluxDB3 = require('../build/lib/DatabaseInfluxDB3').default;

/** Minimal logger stub - collects the messages so token leaks can be asserted */
function stubLogger() {
    const messages = [];
    const collect = level => (...args) => messages.push(`${level}: ${args.join(' ')}`);
    return {
        messages,
        debug: collect('debug'),
        info: collect('info'),
        warn: collect('warn'),
        error: collect('error'),
        silly: collect('silly'),
    };
}

describe('Test line protocol escaping', function () {
    it('escapes measurement names (comma and space)', function () {
        assert.strictEqual(escapeLineProtocolMeasurement('my,measurement'), 'my\\,measurement');
        assert.strictEqual(escapeLineProtocolMeasurement('my measurement'), 'my\\ measurement');
        assert.strictEqual(escapeLineProtocolMeasurement('0_userdata.0.a=b'), '0_userdata.0.a=b');
    });

    it('escapes tag keys and values (comma, equals, space)', function () {
        assert.strictEqual(escapeLineProtocolTagKey('a,b=c d'), 'a\\,b\\=c\\ d');
    });

    it('escapes string fields (backslash and double quote)', function () {
        assert.strictEqual(escapeLineProtocolString('back\\slash'), 'back\\\\slash');
        assert.strictEqual(escapeLineProtocolString('say "hi"'), 'say \\"hi\\"');
    });

    it('escapes identifiers and strings for SQL quoting', function () {
        assert.strictEqual(escapeSqlIdentifier('0_userdata.0."quoted"'), '0_userdata.0.""quoted""');
        assert.strictEqual(escapeSqlString("it's"), "it''s");
    });
});

describe('Test table name mapping for InfluxDB 3', function () {
    it('maps ioBroker ids to Grafana-friendly table names', function () {
        assert.strictEqual(tableNameForId('0_userdata.0.Wetterstation.Temperatur'), '0_userdata_0_Wetterstation_Temperatur');
    });

    it('is idempotent', function () {
        const once = tableNameForId('0_userdata.0.Wetterstation.Temperatur');
        assert.strictEqual(tableNameForId(once), once);
    });

    it('removes all characters that break SQL identifiers or the Grafana picker', function () {
        const name = tableNameForId('0_userdata.0."temperatur (°C)"');
        assert.ok(!name.includes('.') && !name.includes('"') && !name.includes(' '), name);
    });
});

describe('Test line protocol field values', function () {
    it('formats integers with the i suffix', function () {
        assert.strictEqual(formatLineProtocolFieldValue(21), '21i');
    });

    it('formats floats without suffix', function () {
        assert.strictEqual(formatLineProtocolFieldValue(21.7), '21.7');
    });

    it('formats booleans', function () {
        assert.strictEqual(formatLineProtocolFieldValue(true), 'true');
        assert.strictEqual(formatLineProtocolFieldValue(false), 'false');
    });

    it('formats and escapes strings', function () {
        assert.strictEqual(formatLineProtocolFieldValue('OK'), '"OK"');
        assert.strictEqual(formatLineProtocolFieldValue('a"b\\c'), '"a\\"b\\\\c"');
    });

    it('rejects null, non-finite numbers and other types', function () {
        assert.throws(() => formatLineProtocolFieldValue(NaN));
        assert.throws(() => formatLineProtocolFieldValue(Infinity));
        assert.throws(() => formatLineProtocolFieldValue(undefined));
        assert.throws(() => formatLineProtocolFieldValue({}));
    });
});

describe('Test state mapping to line protocol', function () {
    it('writes number with value/q/ack/from fields and ms timestamp', function () {
        const line = stateValueToLineProtocol('0_userdata.0.Wetterstation.Temperatur', {
            value: 21.7,
            time: 1757520000000,
            from: 'system.adapter.test.0',
            q: 0,
            ack: true,
        });
        assert.strictEqual(
            line,
            '0_userdata.0.Wetterstation.Temperatur value=21.7,q=0i,ack=true,from="system.adapter.test.0" 1757520000000',
        );
    });

    it('writes integer values as integer fields', function () {
        const line = stateValueToLineProtocol('dp', { value: 42, time: 1, from: '', q: 3, ack: false });
        assert.ok(line.includes('value=42i'), line);
        assert.ok(line.includes('q=3i'), line);
    });

    it('writes boolean values unconverted', function () {
        const line = stateValueToLineProtocol('dp', { value: true, time: 1, from: '', q: 0, ack: false });
        assert.ok(line.includes('value=true'), line);
        assert.ok(line.includes('ack=false'), line);
    });

    it('writes string values quoted and escaped', function () {
        const line = stateValueToLineProtocol('dp', { value: 'a "quoted" \\ value', time: 1, from: '', q: 0, ack: false });
        assert.ok(line.includes('value="a \\"quoted\\" \\\\ value"'), line);
    });

    it('serializes a whole series into one payload', function () {
        const { body, count } = seriesToLineProtocol({
            a: [
                { value: 1, time: 10, from: '', q: 0, ack: true },
                { value: 2, time: 20, from: '', q: 2, ack: false },
            ],
            b: [{ value: 'x', time: 30, from: 'f', q: 0, ack: true }],
        });
        assert.strictEqual(count, 3);
        assert.strictEqual(body.split('\n').length, 3);
        assert.ok(body.includes('a value=1i,q=0i,ack=true,from="" 10'));
        assert.ok(body.includes('b value="x"'));
    });
});

describe('Test InfluxDB 3 HTTP client', function () {
    /** requests the stub server received: {method, url, headers, body} */
    let received = [];
    /** response the stub server sends: {status, body, delay} */
    let respond = { status: 204, body: '' };
    /** when set, the server answers the probe query (SELECT 1) with 200 and everything else with 405 */
    let respondProbe = false;
    let server;
    let port;

    before(async function () {
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => (body += chunk));
            req.on('end', () => {
                received.push({ method: req.method, url: req.url, headers: req.headers, body });
                if (respondProbe && body.includes('SELECT 1')) {
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ results: [] }));
                    return;
                }
                setTimeout(() => {
                    res.statusCode = respond.status;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(respond.body);
                }, respond.delay || 0);
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    after(function () {
        server.close();
    });

    beforeEach(function () {
        received = [];
        respond = { status: 204, body: '' };
        respondProbe = false;
    });

    function makeClient(requestTimeout = 1000) {
        return new DatabaseInfluxDB3(
            {
                log: stubLogger(),
                host: '127.0.0.1',
                port,
                protocol: 'http',
                database: 'iobroker',
                requestTimeout,
            },
            { token: 'secret-test-token', validateSSL: true },
        );
    }

    it('writes one point via POST /api/v3/write_lp and treats HTTP 204 as success', async function () {
        const client = makeClient();
        await client.writePoint('my.datapoint', { value: 21.7, time: 1757520000000, from: 'a', q: 0, ack: true });

        assert.strictEqual(received.length, 1);
        const req = received[0];
        assert.strictEqual(req.method, 'POST');
        assert.ok(req.url.startsWith('/api/v3/write_lp'), req.url);
        assert.ok(req.url.includes('db=iobroker'), req.url);
        assert.ok(req.url.includes('precision=ms'), req.url);
        assert.strictEqual(req.headers.authorization, 'Bearer secret-test-token');
        // the id is mapped to a Grafana-friendly table name (dots etc. become _)
        assert.ok(req.body.includes('my_datapoint value=21.7'), req.body);
        assert.ok(req.body.endsWith('1757520000000'), req.body);
    });

    it('writes a batch of points as one line protocol payload', async function () {
        const client = makeClient();
        await client.writePoints('my.datapoint', [
            { value: 1, time: 10, from: '', q: 0, ack: false },
            { value: true, time: 20, from: '', q: 0, ack: false },
        ]);
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].body.split('\n').length, 2);
    });

    it('maps HTTP 401 to a readable authentication error', async function () {
        respond = { status: 401, body: '{"message":"unauthorized access"}' };
        const client = makeClient();
        await assert.rejects(
            () => client.writePoint('dp', { value: 1, time: 1, from: '', q: 0, ack: false }),
            error => error.message.includes('401') && error.message.includes('Authentication failed'),
        );
    });

    it('maps HTTP 403 like an authentication error', async function () {
        respond = { status: 403, body: 'forbidden' };
        const client = makeClient();
        await assert.rejects(() => client.writePoint('dp', { value: 1, time: 1, from: '', q: 0, ack: false }), error =>
            error.message.includes('403'),
        );
    });

    it('maps HTTP 404 to a database-not-found hint', async function () {
        respond = { status: 404, body: 'database not found' };
        const client = makeClient();
        await assert.rejects(() => client.writePoint('dp', { value: 1, time: 1, from: '', q: 0, ack: false }), error =>
            error.message.includes('404'),
        );
    });

    it('maps HTTP 400 and HTTP 500 to readable errors', async function () {
        const client = makeClient();

        respond = { status: 400, body: '{"error":"unable to parse line protocol"}' };
        await assert.rejects(() => client.writePoint('dp', { value: 1, time: 1, from: '', q: 0, ack: false }), error =>
            error.message.includes('400'),
        );

        respond = { status: 500, body: 'internal error' };
        await assert.rejects(() => client.writePoint('dp', { value: 1, time: 1, from: '', q: 0, ack: false }), error =>
            error.message.includes('500'),
        );
    });

    it('rejects on timeout', async function () {
        respond = { status: 204, body: '', delay: 3000 };
        const client = makeClient(300);
        await assert.rejects(() => client.writePoint('dp', { value: 1, time: 1, from: '', q: 0, ack: false }));
    });

    it('runs an SQL query and normalizes time to Date', async function () {
        respond = {
            status: 200,
            body: JSON.stringify({ results: [{ value: 21.7, time: '2025-09-10T12:00:00.000Z', ack: true, q: 0, from: 'a' }] }),
        };
        const client = makeClient();
        const rows = await client.query('SELECT * FROM "dp"');
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].value, 21.7);
        assert.ok(rows[0].time instanceof Date);
        assert.strictEqual(received[0].method, 'POST');
        assert.ok(received[0].url.startsWith('/api/v3/query_sql'));
    });

    it('falls back to the probe query when database listing is not implemented', async function () {
        // The SQL dialect of InfluxDB 3 Core does not implement SHOW DATABASES - the server
        // answers 405 for both listing variants, but the probe query succeeds -> the configured
        // database counts as existing
        respondProbe = true;
        // The listing variants must fail like on a real InfluxDB 3 Core (HTTP 405 "not implemented")
        respond = { status: 405, body: 'This feature is not implemented: Unsupported SQL statement: SHOW DATABASES' };
        const client = makeClient();
        const names = await client.getDatabaseNames();
        assert.deepStrictEqual(names, ['iobroker']);
    });

    it('never logs the token', async function () {
        const log = stubLogger();
        const client = new DatabaseInfluxDB3(
            { log, host: '127.0.0.1', port, protocol: 'http', database: 'iobroker', requestTimeout: 1000 },
            { token: 'super-secret-token-value' },
        );
        await client.writePoint('dp', { value: 1, time: 1, from: '', q: 0, ack: false }).catch(() => {});
        for (const message of log.messages) {
            assert.ok(!message.includes('super-secret-token-value'), message);
        }
    });
});
