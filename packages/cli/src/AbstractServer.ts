import { Container } from 'typedi';
import { readFile } from 'fs/promises';
import type { Server } from 'http';
import express from 'express';
import compression from 'compression';
import type { RedisOptions } from 'ioredis';

import { LoggerProxy } from 'n8n-workflow';
import config from '@/config';
import { N8N_VERSION, inDevelopment, inTest } from '@/constants';
import { ActiveWorkflowRunner } from '@/ActiveWorkflowRunner';
import * as Db from '@/Db';
import { ExternalHooks } from '@/ExternalHooks';
import { send, sendErrorResponse, ServiceUnavailableError } from '@/ResponseHelper';
import { rawBody, jsonParser, corsMiddleware } from '@/middlewares';
import { TestWebhooks } from '@/TestWebhooks';
import { WaitingWebhooks } from '@/WaitingWebhooks';
import { getRedisClusterNodes } from './GenericHelpers';
import { webhookRequestHandler } from '@/WebhookHelpers';

export abstract class AbstractServer {
	protected server: Server;

	readonly app: express.Application;

	protected externalHooks = Container.get(ExternalHooks);

	protected activeWorkflowRunner = Container.get(ActiveWorkflowRunner);

	readonly port = config.getEnv('port');

	readonly protocol = config.getEnv('protocol');

	readonly sslKey = config.getEnv('ssl_key');

	readonly sslCert = config.getEnv('ssl_cert');

	readonly timezone = config.getEnv('generic.timezone');

	readonly restEndpoint = config.getEnv('endpoints.rest');

	readonly endpointWebhook = config.getEnv('endpoints.webhook');

	readonly endpointWebhookTest = config.getEnv('endpoints.webhookTest');

	readonly endpointWebhookWaiting = config.getEnv('endpoints.webhookWaiting');

	protected instanceId = '';

	protected webhooksEnabled = true;

	protected testWebhooksEnabled = false;

	constructor() {
		this.app.disable('x-powered-by');
	}

	async configure(): Promise<void> {
		// Additional configuration in derived classes
	}

	private async setupErrorHandlers() {
		const { app } = this;

		// Augment errors sent to Sentry
		const {
			Handlers: { requestHandler, errorHandler },
		} = await import('@sentry/node');
		app.use(requestHandler());
		app.use(errorHandler());
	}

	private setupCommonMiddlewares() {
		// Compress the response data
		this.app.use(compression());

		// Read incoming data into `rawBody`
		this.app.use(rawBody);
	}

	private setupDevMiddlewares() {
		this.app.use(corsMiddleware);
	}

	protected setupPushServer() {}

	private async setupHealthCheck() {
		// health check should not care about DB connections
		this.app.get('/healthz', async (req, res) => {
			res.send({ status: 'ok' });
		});

		const { connectionState } = Db;
		this.app.use((req, res, next) => {
			if (connectionState.connected) {
				if (connectionState.migrated) next();
				else res.send('n8n is starting up. Please wait');
			} else sendErrorResponse(res, new ServiceUnavailableError('Database is not ready!'));
		});

		if (config.getEnv('executions.mode') === 'queue') {
			await this.setupRedisChecks();
		}
	}

	// This connection is going to be our heartbeat
	// IORedis automatically pings redis and tries to reconnect
	// We will be using a retryStrategy to control how and when to exit.
	private async setupRedisChecks() {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		const { default: Redis } = await import('ioredis');

		let lastTimer = 0;
		let cumulativeTimeout = 0;
		const { host, port, username, password, db }: RedisOptions = config.getEnv('queue.bull.redis');
		const clusterNodes = getRedisClusterNodes();
		const redisConnectionTimeoutLimit = config.getEnv('queue.bull.redis.timeoutThreshold');
		const usesRedisCluster = clusterNodes.length > 0;
		LoggerProxy.debug(
			usesRedisCluster
				? `Initialising Redis cluster connection with nodes: ${clusterNodes
						.map((e) => `${e.host}:${e.port}`)
						.join(',')}`
				: `Initialising Redis client connection with host: ${host ?? 'localhost'} and port: ${
						port ?? '6379'
				  }`,
		);
		const sharedRedisOptions: RedisOptions = {
			username,
			password,
			db,
			enableReadyCheck: false,
			maxRetriesPerRequest: null,
		};
		const redis = usesRedisCluster
			? new Redis.Cluster(
					clusterNodes.map((node) => ({ host: node.host, port: node.port })),
					{
						redisOptions: sharedRedisOptions,
					},
			  )
			: new Redis({
					host,
					port,
					...sharedRedisOptions,
					retryStrategy: (): number | null => {
						const now = Date.now();
						if (now - lastTimer > 30000) {
							// Means we had no timeout at all or last timeout was temporary and we recovered
							lastTimer = now;
							cumulativeTimeout = 0;
						} else {
							cumulativeTimeout += now - lastTimer;
							lastTimer = now;
							if (cumulativeTimeout > redisConnectionTimeoutLimit) {
								LoggerProxy.error(
									`Unable to connect to Redis after ${redisConnectionTimeoutLimit}. Exiting process.`,
								);
								process.exit(1);
							}
						}
						return 500;
					},
			  });

		redis.on('close', () => {
			LoggerProxy.warn('Redis unavailable - trying to reconnect...');
		});

		redis.on('error', (error) => {
			if (!String(error).includes('ECONNREFUSED')) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
				LoggerProxy.warn('Error with Redis: ', error);
			}
		});
	}

	async init(): Promise<void> {
		const { app, protocol, sslKey, sslCert } = this;

		if (protocol === 'https' && sslKey && sslCert) {
			const https = await import('https');
			this.server = https.createServer(
				{
					key: await readFile(this.sslKey, 'utf8'),
					cert: await readFile(this.sslCert, 'utf8'),
				},
				app,
			);
		} else {
			const http = await import('http');
			this.server = http.createServer(app);
		}

		const ADDRESS = config.getEnv('listen_address');

		this.server.on('error', (error: Error & { code: string }) => {
			if (error.code === 'EADDRINUSE') {
				console.log(
					`n8n's port ${this.port} is already in use. Do you have another instance of n8n running already?`,
				);
				process.exit(1);
			}
		});

		await new Promise<void>((resolve) => this.server.listen(this.port, ADDRESS, () => resolve()));

		this.externalHooks = Container.get(ExternalHooks);
		this.activeWorkflowRunner = Container.get(ActiveWorkflowRunner);

		await this.setupHealthCheck();

		console.log(`Version: ${N8N_VERSION}`);
		console.log(`n8n ready on ${ADDRESS}, port ${this.port}`);
	}

	async start(): Promise<void> {
		if (!inTest) {
			await this.setupErrorHandlers();
			this.setupPushServer();
		}

		this.setupCommonMiddlewares();

		// Setup webhook handlers before bodyParser, to let the Webhook node handle binary data in requests
		if (this.webhooksEnabled) {
			// Register a handler for active webhooks
			this.app.all(
				`/${this.endpointWebhook}/:path(*)`,
				webhookRequestHandler(Container.get(ActiveWorkflowRunner)),
			);

			// Register a handler for waiting webhooks
			this.app.all(
				`/${this.endpointWebhookWaiting}/:path/:suffix?`,
				webhookRequestHandler(Container.get(WaitingWebhooks)),
			);
		}

		if (this.testWebhooksEnabled) {
			const testWebhooks = Container.get(TestWebhooks);

			// Register a handler for test webhooks
			this.app.all(`/${this.endpointWebhookTest}/:path(*)`, webhookRequestHandler(testWebhooks));

			// Removes a test webhook
			// TODO UM: check if this needs validation with user management.
			this.app.delete(
				`/${this.restEndpoint}/test-webhook/:id`,
				send(async (req) => testWebhooks.cancelTestWebhook(req.params.id)),
			);
		}

		if (inDevelopment) {
			this.setupDevMiddlewares();
		}

		// Setup JSON parsing middleware after the webhook handlers are setup
		this.app.use(jsonParser);

		await this.configure();

		if (!inTest) {
			console.log(`Version: ${N8N_VERSION}`);

			const defaultLocale = config.getEnv('defaultLocale');
			if (defaultLocale !== 'en') {
				console.log(`Locale: ${defaultLocale}`);
			}

			await this.externalHooks.run('n8n.ready', [this, config]);
		}
	}
}
