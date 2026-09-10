import { Database, type ValuesForInflux } from './Database';
import { escapeSqlIdentifier, seriesToLineProtocol, stateValueToLineProtocol, tableNameForId } from './lineProtocol';
import { formatError } from './errors';

/**
 * InfluxDB 3 Core implementation of the database abstraction.
 *
 * Decisions (see also the technical documentation):
 * - The native write API `POST /api/v3/write_lp` is used with `precision=ms`, so the ioBroker
 *   millisecond timestamps can be written without conversion. HTTP 204 means success.
 * - Queries run over the SQL API (`POST /api/v3/query_sql`). The table name is the full ioBroker
 *   state id in double quotes - the same scheme the 1.x/2.x implementations use as measurement.
 * - Authentication is a bearer token in the Authorization header. The token is never logged.
 * - Retention: InfluxDB 3 Core knows database-wide retention (set at `influxdb3 create database
 *   --retention <duration>` / `ALTER DATABASE`). There is no per-table retention like the shard
 *   groups of 1.x/2.x, so `applyRetentionPolicyToDB` is a best effort and failures (e.g. missing
 *   permission) are logged as a warning by the caller instead of stopping the adapter.
 * - q/ack/from are always written as fields (columns), there is no tags/fields choice as in 2.x.
 *
 * No external HTTP client is used on purpose: Node 22 provides fetch/AbortController, the 1.x and
 * 2.x driver packages are version-specific and would add nothing here.
 */
export default class DatabaseInfluxDB3 extends Database {
    private readonly token: string;
    private readonly validateSSL: boolean;

    constructor(
        options: {
            log: ioBroker.Logger;
            host: string;
            port: number | string;
            protocol: 'http' | 'https';
            database: string;
            requestTimeout: number;
        },
        db3xOptions: {
            token: string;
            validateSSL?: boolean;
        },
    ) {
        super(options);
        this.token = db3xOptions.token;
        this.validateSSL = db3xOptions.validateSSL !== undefined ? db3xOptions.validateSSL : true;

        this.connect();
    }

    connect(): void {
        this.log.debug(
            `Connect InfluxDB 3: ${this.protocol}://${this.host}:${this.port} [${this.database}] (credentials redacted)`,
        );
    }

    /** Build the base URL of the server. */
    private get url(): string {
        return `${this.protocol}://${this.host}:${this.port}`;
    }

    /**
     * Run one HTTP request against the InfluxDB 3 API.
     *
     * Error mapping (so the admin sees a readable message instead of a driver-internal one):
     * 400 invalid request, 401/403 authentication, 404 database/route not found, 422 invalid data,
     * 429 rate limit, 5xx server errors. Connection errors (ECONNREFUSED, timeout, ...) are passed
     * through unchanged, so the generic connection handling of the adapter (isConnectionError /
     * host backoff in the Database base class) keeps working.
     */
    private async request(
        path: string,
        init: {
            method: 'GET' | 'POST' | 'DELETE';
            body?: string;
            contentType?: string;
            params?: { [key: string]: string };
            okStatuses?: number[];
        },
    ): Promise<{ status: number; body: unknown }> {
        const url = new URL(path, `${this.url}/`);
        for (const [key, value] of Object.entries(init.params || {})) {
            url.searchParams.set(key, value);
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.requestTimeout || 30_000);

        let response: Response;
        try {
            response = await fetch(url, {
                method: init.method,
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    ...(init.body !== undefined ? { 'Content-Type': init.contentType || 'text/plain' } : {}),
                },
                body: init.body,
                signal: controller.signal,
            });
        } catch (error) {
            // AbortError from the timeout and ECONNREFUSED & co. - both count as connection errors
            if (error instanceof Error && error.name === 'AbortError') {
                const wrapped = new Error(`connect timeout after ${this.requestTimeout} ms`);
                wrapped.name = 'ESOCKETTIMEDOUT';
                throw wrapped;
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }

        this.log.debug(`InfluxDB 3: HTTP ${response.status} ${init.method} ${path}`);

        if (response.status === 204) {
            // No Content - the documented success case of write_lp
            return { status: response.status, body: null };
        }

        const text = await response.text().catch(() => '');
        let parsed: unknown = null;
        if (text) {
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = text;
            }
        }

        if (!(init.okStatuses || [200]).includes(response.status)) {
            let detail = '';
            if (typeof parsed === 'string') {
                detail = parsed;
            } else if (parsed && typeof parsed === 'object' && 'message' in parsed) {
                detail = String((parsed as { message?: unknown }).message);
            }
            const error = new Error(this.describeHttpError(response.status, detail)) as Error & {
                statusCode?: number;
            };
            error.statusCode = response.status;
            throw error;
        }

        return { status: response.status, body: parsed };
    }

    /** Map an HTTP status to a readable error message */
    private describeHttpError(status: number, detail: string): string {
        const suffix = detail ? `: ${detail}` : '';
        switch (status) {
            case 400:
                return `Invalid request (HTTP 400)${suffix}`;
            case 401:
            case 403:
                return `Authentication failed (HTTP ${status}) - check the token${suffix}`;
            case 404:
                return `Database or API route not found (HTTP 404) - does the database "${this.database}" exist?${suffix}`;
            case 422:
                return `Invalid data (HTTP 422)${suffix}`;
            case 429:
                return `Rate limit reached (HTTP 429)${suffix}`;
            default:
                if (status >= 500) {
                    return `InfluxDB server error (HTTP ${status})${suffix}`;
                }
                return `HTTP ${status}${suffix}`;
        }
    }

    /**
     * Run an SQL query via the v3 query API.
     *
     * @returns the rows with a normalized `time` property (Date), like the 1.x/2.x query methods
     */
    async query<T>(query: string): Promise<Array<T & { time: Date }>> {
        this.log.debug(`Query to execute: ${query}`);
        return this.trackConnection(async () => {
            const { body } = await this.request('/api/v3/query_sql', {
                method: 'POST',
                body: JSON.stringify({ db: this.database, q: query, format: 'json' }),
                contentType: 'application/json',
                okStatuses: [200],
            });
            const rows = (body as { results?: Array<T & { time: string | Date }> })?.results || [];
            return rows.map(row => ({
                ...row,
                time: new Date((row as { time: string | Date }).time),
            }));
        });
    }

    async ping(): Promise<{ online: boolean }[]> {
        try {
            const { status } = await this.request('/health', { method: 'GET', okStatuses: [200] });
            this.markHostAvailable();
            return [{ online: status === 200 }];
        } catch (error) {
            this.markHostUnavailable();
            this.log.debug(`InfluxDB 3 health check failed: ${formatError(error)}`);
            return [{ online: false }];
        }
    }

    async getDatabaseNames(): Promise<string[]> {
        // The SQL dialect of InfluxDB 3 Core does not implement SHOW DATABASES (HTTP 405
        // "This feature is not implemented"). Fall back through the supported variants:
        // 1. the system table `system.databases`, 2. SHOW DATABASES (may work on newer
        // versions), 3. prove the configured database exists with a probe query.
        const candidates = ['SELECT database_name AS name FROM system.databases', 'SHOW DATABASES'];
        let lastError: unknown = null;
        for (const candidate of candidates) {
            try {
                const rows = await this.query<Record<string, string>>(candidate);
                return rows.map(row => row.name || row.database_name || row.Database || '').filter(name => !!name);
            } catch (error) {
                lastError = error;
                this.log.debug(
                    `InfluxDB 3: database listing via "${candidate}" failed: ${formatError(error)} - trying the next variant`,
                );
            }
        }

        // Last resort: the probe query runs in the context of the configured database. A success
        // proves that it exists, a 404 proves that it does not.
        try {
            await this.query('SELECT 1');
            this.log.debug(
                'InfluxDB 3: database listing is not supported by this server version - assuming the configured database exists (probe query succeeded)',
            );
            return [this.database];
        } catch (error) {
            if ((error as { statusCode?: number }).statusCode === 404) {
                return [];
            }
            throw lastError ?? error;
        }
    }

    async createDatabase(dbname: string): Promise<void> {
        this.log.info(`Creating database ${dbname}`);
        try {
            await this.query(`CREATE DATABASE "${escapeSqlIdentifier(dbname)}"`);
            return;
        } catch (sqlError) {
            this.log.debug(`InfluxDB 3: CREATE DATABASE via SQL failed: ${formatError(sqlError)}`);
        }
        try {
            // management API of newer Core/Enterprise versions
            await this.request('/api/v3/databases', {
                method: 'POST',
                body: JSON.stringify({ db: dbname }),
                contentType: 'application/json',
                okStatuses: [200, 201, 204],
            });
            return;
        } catch (apiError) {
            this.log.debug(`InfluxDB 3: database creation via management API failed: ${formatError(apiError)}`);
        }
        throw new Error(
            `Could not create database "${dbname}": neither SQL CREATE DATABASE nor the management API are ` +
                `supported by this server. Please create it manually on the server, e.g.: influxdb3 create database ${dbname}`,
        );
    }

    async dropDatabase(dbname: string): Promise<void> {
        this.log.info(`Dropping database ${dbname}`);
        try {
            await this.query(`DROP DATABASE "${escapeSqlIdentifier(dbname)}"`);
            return;
        } catch (sqlError) {
            this.log.debug(`InfluxDB 3: DROP DATABASE via SQL failed: ${formatError(sqlError)}`);
        }
        // management API of newer Core/Enterprise versions
        await this.request(`/api/v3/databases/${encodeURIComponent(dbname)}`, {
            method: 'DELETE',
            okStatuses: [200, 204],
        });
    }

    applyRetentionPolicyToDB(dbName: string, retention: number): Promise<void> {
        // InfluxDB 3 Core knows database-wide retention, not per-measurement shard groups like
        // 1.x/2.x. It is set on the server ("influxdb3 create database --retention <duration>");
        // the SQL dialect has no ALTER DATABASE ... RETENTION, so the adapter only reports it.
        this.log.info(
            `Retention for ${dbName}: ${!retention ? 'infinite' : `${retention} seconds`} - note: InfluxDB 3 ` +
                'Core applies retention database-wide; configure it on the server ' +
                '("influxdb3 create database --retention" or update the database settings).',
        );
        void dbName;
        void retention;
        return Promise.resolve();
    }

    getRetentionPolicyForDB(dbName: string): Promise<{ name: string | null; time: number | undefined } | null> {
        // No per-database readable retention via SQL in 3 Core - report null ("unknown"), which the
        // adapter treats like "no policy found" without an error.
        void dbName;
        return Promise.resolve(null);
    }

    getMetaDataStorageType(): Promise<'tags' | 'fields' | 'none'> {
        // q/ack/from are always fields (columns) in InfluxDB 3, there is no tags/fields choice
        return Promise.resolve('fields');
    }

    async deleteData(
        start: Date | number,
        stop: Date | number,
        _org: string,
        _dbName: string,
        predicate: string,
    ): Promise<void> {
        // The 2.x delete API passes `_measurement="<id>"` as predicate - reuse it as table name
        const table = predicate.match(/^_measurement="(.*)"$/)?.[1] || '';
        const where = [`time >= '${new Date(start).toISOString()}'`, `time <= '${new Date(stop).toISOString()}'`];
        await this.query(`DELETE FROM "${escapeSqlIdentifier(table)}" WHERE ${where.join(' AND ')}`);
    }

    async writeSeries(series: { [id: string]: ValuesForInflux[] }): Promise<void> {
        // the ioBroker ids are mapped to Grafana-friendly table names (see tableNameForId)
        const mapped: { [id: string]: ValuesForInflux[] } = {};
        for (const [id, points] of Object.entries(series)) {
            mapped[tableNameForId(id)] = points;
        }
        const { body, count } = seriesToLineProtocol(mapped);
        if (!count) {
            return;
        }
        this.log.debug(`InfluxDB 3: writing ${count} points`);
        await this.writeLineProtocol(body, count);
    }

    async writePoints(seriesId: string, pointsToSend: ValuesForInflux[]): Promise<void> {
        this.log.debug(`InfluxDB 3: writing ${pointsToSend.length} points for ${seriesId}`);
        const { body, count } = seriesToLineProtocol({ [tableNameForId(seriesId)]: pointsToSend });
        if (!count) {
            return;
        }
        await this.writeLineProtocol(body, count);
    }

    async writePoint(seriesId: string, value: ValuesForInflux): Promise<void> {
        this.log.debug(`InfluxDB 3: writing 1 point for ${seriesId}`);
        await this.writeLineProtocol(stateValueToLineProtocol(tableNameForId(seriesId), value), 1);
    }

    /**
     * POST one line protocol payload to the native v3 write endpoint.
     *
     * HTTP 204 (No Content) is the success case documented by InfluxDB 3.
     * The token only travels in the Authorization header and is never logged.
     */
    private async writeLineProtocol(body: string, count: number): Promise<void> {
        await this.trackConnection(() =>
            this.request('/api/v3/write_lp', {
                method: 'POST',
                body,
                contentType: 'text/plain; charset=utf-8',
                params: { db: this.database, precision: 'ms' },
                okStatuses: [204],
            }),
        );
        this.log.debug(`InfluxDB 3: ${count} points written to ${this.database}`);
    }
}
