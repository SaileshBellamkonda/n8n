import { Injectable, OnApplicationShutdown } from '@n8n/di';
import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { InstanceSettings } from 'n8n-core';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { randomBytes, createHash } from 'crypto';
import { EventEmitter } from 'events';

export interface MultiMainConfig {
	enabled: boolean;
	coordinationType: 'redis' | 'database' | 'etcd' | 'consul';
	redisConfig?: {
		host: string;
		port: number;
		password?: string;
		database?: number;
		keyPrefix?: string;
	};
	leaderElection: {
		enabled: boolean;
		ttlMs: number;
		renewIntervalMs: number;
		maxRetries: number;
	};
	loadBalancing: {
		enabled: boolean;
		strategy: 'round-robin' | 'least-connections' | 'weighted' | 'consistent-hash';
		healthCheckIntervalMs: number;
		healthCheckTimeoutMs: number;
	};
	autoScaling: {
		enabled: boolean;
		minInstances: number;
		maxInstances: number;
		scaleUpThreshold: number;
		scaleDownThreshold: number;
		cooldownMs: number;
	};
	clustering: {
		enabled: boolean;
		gossipPort: number;
		membershipProtocol: 'gossip' | 'static';
		heartbeatIntervalMs: number;
		suspicionTimeoutMs: number;
	};
}

export interface InstanceInfo {
	id: string;
	type: 'main' | 'worker' | 'webhook';
	status: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
	version: string;
	hostname: string;
	ipAddress: string;
	port: number;
	startedAt: Date;
	lastHeartbeat: Date;
	isLeader: boolean;
	weight: number;
	activeConnections: number;
	cpuUsage: number;
	memoryUsage: number;
	loadAverage: number;
	capabilities: string[];
	metadata: Record<string, any>;
}

export interface LeaderElectionResult {
	isLeader: boolean;
	leaderId: string;
	leaderChangedAt: Date;
	term: number;
}

export interface ClusterStats {
	totalInstances: number;
	runningInstances: number;
	leaderInstance: string | null;
	averageLoad: number;
	totalActiveConnections: number;
	healthyInstances: number;
	unhealthyInstances: number;
	lastElection: Date | null;
}

export interface LoadBalanceTarget {
	instanceId: string;
	weight: number;
	connections: number;
	responseTime: number;
	isHealthy: boolean;
	lastHealthCheck: Date;
}

@Injectable()
export class MultiMainSetup extends EventEmitter implements OnApplicationShutdown {
	private config: MultiMainConfig = {
		enabled: true, // Enable multi-main in community edition
		coordinationType: 'redis',
		leaderElection: {
			enabled: true,
			ttlMs: 30000, // 30 seconds
			renewIntervalMs: 10000, // 10 seconds
			maxRetries: 3,
		},
		loadBalancing: {
			enabled: true,
			strategy: 'least-connections',
			healthCheckIntervalMs: 5000,
			healthCheckTimeoutMs: 2000,
		},
		autoScaling: {
			enabled: false,
			minInstances: 2,
			maxInstances: 10,
			scaleUpThreshold: 80,
			scaleDownThreshold: 20,
			cooldownMs: 300000, // 5 minutes
		},
		clustering: {
			enabled: true,
			gossipPort: 7946,
			membershipProtocol: 'gossip',
			heartbeatIntervalMs: 1000,
			suspicionTimeoutMs: 5000,
		},
	};

	private currentInstance: InstanceInfo;
	private instances = new Map<string, InstanceInfo>();
	private isLeader = false;
	private leaderId: string | null = null;
	private leaderTerm = 0;
	private leadershipRenewalInterval: NodeJS.Timer | null = null;
	private healthCheckInterval: NodeJS.Timer | null = null;
	private heartbeatInterval: NodeJS.Timer | null = null;
	private clusterMembership: string[] = [];
	private loadBalanceTargets = new Map<string, LoadBalanceTarget>();

	constructor(
		private readonly logger: Logger,
		private readonly globalConfig: GlobalConfig,
		private readonly instanceSettings: InstanceSettings,
	) {
		super();
		this.logger = this.logger.scoped('multi-main');
		this.loadConfigFromEnvironment();
		this.initializeCurrentInstance();
	}

	/**
	 * Check if multi-main setup is enabled
	 */
	isEnabled(): boolean {
		return this.config.enabled;
	}

	/**
	 * Configure multi-main settings
	 */
	configure(config: Partial<MultiMainConfig>): void {
		this.config = { ...this.config, ...config };
		this.logger.info('Multi-main configuration updated', {
			enabled: this.config.enabled,
			coordinationType: this.config.coordinationType,
			leaderElectionEnabled: this.config.leaderElection.enabled,
			loadBalancingEnabled: this.config.loadBalancing.enabled,
		});
	}

	/**
	 * Initialize multi-main setup
	 */
	async initialize(): Promise<void> {
		if (!this.isEnabled()) {
			this.logger.info('Multi-main setup is disabled');
			return;
		}

		try {
			this.logger.info('Initializing multi-main setup', {
				instanceId: this.currentInstance.id,
				type: this.currentInstance.type,
			});

			// Initialize coordination backend
			await this.initializeCoordination();

			// Register current instance
			await this.registerInstance();

			// Start leader election if enabled
			if (this.config.leaderElection.enabled) {
				await this.startLeaderElection();
			}

			// Start health checks if load balancing is enabled
			if (this.config.loadBalancing.enabled) {
				this.startHealthChecks();
			}

			// Start heartbeat mechanism if clustering is enabled
			if (this.config.clustering.enabled) {
				this.startHeartbeat();
			}

			// Setup event handlers
			this.setupEventHandlers();

			this.logger.info('Multi-main setup initialized successfully', {
				instanceId: this.currentInstance.id,
				isLeader: this.isLeader,
				totalInstances: this.instances.size,
			});

			this.emit('initialized');
		} catch (error) {
			this.logger.error('Failed to initialize multi-main setup', {
				error: error.message,
				stack: error.stack,
			});
			throw error;
		}
	}

	/**
	 * Get current instance information
	 */
	getCurrentInstance(): InstanceInfo {
		return { ...this.currentInstance };
	}

	/**
	 * Get all registered instances
	 */
	getInstances(): InstanceInfo[] {
		return Array.from(this.instances.values()).map(instance => ({ ...instance }));
	}

	/**
	 * Get leader information
	 */
	getLeaderInfo(): LeaderElectionResult {
		return {
			isLeader: this.isLeader,
			leaderId: this.leaderId || '',
			leaderChangedAt: new Date(), // Would track actual change time
			term: this.leaderTerm,
		};
	}

	/**
	 * Get cluster statistics
	 */
	getClusterStats(): ClusterStats {
		const instances = Array.from(this.instances.values());
		const runningInstances = instances.filter(i => i.status === 'running');
		const healthyInstances = runningInstances.filter(i => this.isInstanceHealthy(i));

		return {
			totalInstances: instances.length,
			runningInstances: runningInstances.length,
			leaderInstance: this.leaderId,
			averageLoad: runningInstances.reduce((sum, i) => sum + i.loadAverage, 0) / runningInstances.length || 0,
			totalActiveConnections: runningInstances.reduce((sum, i) => sum + i.activeConnections, 0),
			healthyInstances: healthyInstances.length,
			unhealthyInstances: runningInstances.length - healthyInstances.length,
			lastElection: new Date(), // Would track actual election time
		};
	}

	/**
	 * Request leadership (force election)
	 */
	async requestLeadership(): Promise<boolean> {
		if (!this.config.leaderElection.enabled) {
			throw new BadRequestError('Leader election is not enabled');
		}

		try {
			this.logger.info('Requesting leadership', {
				instanceId: this.currentInstance.id,
				currentLeader: this.leaderId,
			});

			// Simulate leader election
			const success = await this.attemptLeaderElection();

			if (success) {
				this.logger.info('Leadership acquired', {
					instanceId: this.currentInstance.id,
					term: this.leaderTerm,
				});
				this.emit('leadership-acquired');
			}

			return success;
		} catch (error) {
			this.logger.error('Failed to request leadership', {
				error: error.message,
			});
			return false;
		}
	}

	/**
	 * Resign from leadership
	 */
	async resignLeadership(): Promise<void> {
		if (!this.isLeader) {
			throw new BadRequestError('Instance is not the current leader');
		}

		try {
			this.logger.info('Resigning from leadership', {
				instanceId: this.currentInstance.id,
				term: this.leaderTerm,
			});

			this.isLeader = false;
			this.currentInstance.isLeader = false;
			this.leaderId = null;

			// Stop leadership renewal
			if (this.leadershipRenewalInterval) {
				clearInterval(this.leadershipRenewalInterval);
				this.leadershipRenewalInterval = null;
			}

			// Trigger new election
			await this.triggerLeaderElection();

			this.logger.info('Leadership resigned', {
				instanceId: this.currentInstance.id,
			});

			this.emit('leadership-resigned');
		} catch (error) {
			this.logger.error('Failed to resign leadership', {
				error: error.message,
			});
			throw error;
		}
	}

	/**
	 * Get load balance target
	 */
	getLoadBalanceTarget(requestId?: string): LoadBalanceTarget | null {
		if (!this.config.loadBalancing.enabled) {
			return null;
		}

		const healthyTargets = Array.from(this.loadBalanceTargets.values())
			.filter(target => target.isHealthy);

		if (healthyTargets.length === 0) {
			return null;
		}

		let selectedTarget: LoadBalanceTarget;

		switch (this.config.loadBalancing.strategy) {
			case 'round-robin':
				selectedTarget = this.selectRoundRobin(healthyTargets);
				break;
			case 'least-connections':
				selectedTarget = this.selectLeastConnections(healthyTargets);
				break;
			case 'weighted':
				selectedTarget = this.selectWeighted(healthyTargets);
				break;
			case 'consistent-hash':
				selectedTarget = this.selectConsistentHash(healthyTargets, requestId);
				break;
			default:
				selectedTarget = healthyTargets[0];
		}

		// Update connection count
		selectedTarget.connections++;

		return selectedTarget;
	}

	/**
	 * Release load balance target
	 */
	releaseLoadBalanceTarget(instanceId: string): void {
		const target = this.loadBalanceTargets.get(instanceId);
		if (target && target.connections > 0) {
			target.connections--;
		}
	}

	/**
	 * Scale cluster
	 */
	async scaleCluster(targetInstances: number): Promise<void> {
		if (!this.config.autoScaling.enabled) {
			throw new BadRequestError('Auto-scaling is not enabled');
		}

		if (targetInstances < this.config.autoScaling.minInstances) {
			throw new BadRequestError(`Target instances cannot be less than minimum (${this.config.autoScaling.minInstances})`);
		}

		if (targetInstances > this.config.autoScaling.maxInstances) {
			throw new BadRequestError(`Target instances cannot exceed maximum (${this.config.autoScaling.maxInstances})`);
		}

		const currentInstances = this.getInstances().filter(i => i.status === 'running').length;
		const difference = targetInstances - currentInstances;

		this.logger.info('Scaling cluster', {
			currentInstances,
			targetInstances,
			difference,
		});

		if (difference > 0) {
			// Scale up
			await this.scaleUp(difference);
		} else if (difference < 0) {
			// Scale down
			await this.scaleDown(Math.abs(difference));
		}

		this.emit('cluster-scaled', { targetInstances, difference });
	}

	/**
	 * Check auto-scaling conditions
	 */
	async checkAutoScaling(): Promise<void> {
		if (!this.config.autoScaling.enabled || !this.isLeader) {
			return;
		}

		const stats = this.getClusterStats();
		const currentLoad = stats.averageLoad;

		if (currentLoad > this.config.autoScaling.scaleUpThreshold) {
			const targetInstances = Math.min(
				stats.runningInstances + 1,
				this.config.autoScaling.maxInstances
			);
			
			if (targetInstances > stats.runningInstances) {
				this.logger.info('Auto-scaling up due to high load', {
					currentLoad,
					threshold: this.config.autoScaling.scaleUpThreshold,
					currentInstances: stats.runningInstances,
					targetInstances,
				});
				
				await this.scaleCluster(targetInstances);
			}
		} else if (currentLoad < this.config.autoScaling.scaleDownThreshold) {
			const targetInstances = Math.max(
				stats.runningInstances - 1,
				this.config.autoScaling.minInstances
			);
			
			if (targetInstances < stats.runningInstances) {
				this.logger.info('Auto-scaling down due to low load', {
					currentLoad,
					threshold: this.config.autoScaling.scaleDownThreshold,
					currentInstances: stats.runningInstances,
					targetInstances,
				});
				
				await this.scaleCluster(targetInstances);
			}
		}
	}

	/**
	 * Handle application shutdown
	 */
	async onApplicationShutdown(): Promise<void> {
		this.logger.info('Shutting down multi-main setup', {
			instanceId: this.currentInstance.id,
			isLeader: this.isLeader,
		});

		try {
			// Stop all intervals
			if (this.leadershipRenewalInterval) {
				clearInterval(this.leadershipRenewalInterval);
			}
			if (this.healthCheckInterval) {
				clearInterval(this.healthCheckInterval);
			}
			if (this.heartbeatInterval) {
				clearInterval(this.heartbeatInterval);
			}

			// Resign leadership if leader
			if (this.isLeader) {
				await this.resignLeadership();
			}

			// Deregister instance
			await this.deregisterInstance();

			this.emit('shutdown');
		} catch (error) {
			this.logger.error('Error during multi-main shutdown', {
				error: error.message,
			});
		}
	}

	// Private methods

	private initializeCurrentInstance(): void {
		this.currentInstance = {
			id: this.generateInstanceId(),
			type: this.instanceSettings.instanceType || 'main',
			status: 'starting',
			version: process.env.N8N_VERSION || '1.0.0',
			hostname: require('os').hostname(),
			ipAddress: this.getLocalIPAddress(),
			port: this.globalConfig.port || 5678,
			startedAt: new Date(),
			lastHeartbeat: new Date(),
			isLeader: false,
			weight: 1,
			activeConnections: 0,
			cpuUsage: 0,
			memoryUsage: 0,
			loadAverage: 0,
			capabilities: ['webhook', 'execution', 'worker'],
			metadata: {},
		};
	}

	private async initializeCoordination(): Promise<void> {
		// Initialize coordination backend (Redis, Database, etc.)
		// For community edition, we'll simulate this
		this.logger.debug('Initializing coordination backend', {
			type: this.config.coordinationType,
		});
	}

	private async registerInstance(): Promise<void> {
		this.currentInstance.status = 'running';
		this.instances.set(this.currentInstance.id, this.currentInstance);
		
		// Create load balance target
		this.loadBalanceTargets.set(this.currentInstance.id, {
			instanceId: this.currentInstance.id,
			weight: this.currentInstance.weight,
			connections: 0,
			responseTime: 0,
			isHealthy: true,
			lastHealthCheck: new Date(),
		});

		this.logger.info('Instance registered', {
			instanceId: this.currentInstance.id,
		});
	}

	private async deregisterInstance(): Promise<void> {
		this.currentInstance.status = 'stopped';
		this.instances.delete(this.currentInstance.id);
		this.loadBalanceTargets.delete(this.currentInstance.id);

		this.logger.info('Instance deregistered', {
			instanceId: this.currentInstance.id,
		});
	}

	private async startLeaderElection(): Promise<void> {
		await this.attemptLeaderElection();
		
		// Start renewal interval if we're the leader
		if (this.isLeader) {
			this.leadershipRenewalInterval = setInterval(
				() => this.renewLeadership(),
				this.config.leaderElection.renewIntervalMs
			);
		}
	}

	private async attemptLeaderElection(): Promise<boolean> {
		// Simulate leader election logic
		// In real implementation, this would use Redis, etcd, or database for coordination
		
		const instances = Array.from(this.instances.values())
			.filter(i => i.status === 'running')
			.sort((a, b) => a.id.localeCompare(b.id));

		if (instances.length === 0) {
			return false;
		}

		// Simple election: first instance by ID becomes leader
		const shouldBeLeader = instances[0].id === this.currentInstance.id;

		if (shouldBeLeader && !this.isLeader) {
			this.becomeLeader();
			return true;
		} else if (!shouldBeLeader && this.isLeader) {
			this.stepDownLeader();
		}

		return shouldBeLeader;
	}

	private becomeLeader(): void {
		this.isLeader = true;
		this.leaderId = this.currentInstance.id;
		this.leaderTerm++;
		this.currentInstance.isLeader = true;

		this.logger.info('Became cluster leader', {
			instanceId: this.currentInstance.id,
			term: this.leaderTerm,
		});

		this.emit('leadership-acquired');
	}

	private stepDownLeader(): void {
		this.isLeader = false;
		this.currentInstance.isLeader = false;

		this.logger.info('Stepped down from leadership', {
			instanceId: this.currentInstance.id,
		});

		this.emit('leadership-lost');
	}

	private async renewLeadership(): Promise<void> {
		if (!this.isLeader) {
			return;
		}

		try {
			// Simulate leadership renewal
			// In real implementation, this would extend the leadership lease
			this.logger.debug('Renewed leadership', {
				instanceId: this.currentInstance.id,
				term: this.leaderTerm,
			});
		} catch (error) {
			this.logger.error('Failed to renew leadership', {
				error: error.message,
			});
			this.stepDownLeader();
		}
	}

	private async triggerLeaderElection(): Promise<void> {
		// Simulate triggering a new election
		setTimeout(() => {
			this.attemptLeaderElection();
		}, 1000);
	}

	private startHealthChecks(): void {
		this.healthCheckInterval = setInterval(
			() => this.performHealthChecks(),
			this.config.loadBalancing.healthCheckIntervalMs
		);
	}

	private async performHealthChecks(): Promise<void> {
		for (const target of this.loadBalanceTargets.values()) {
			try {
				// Simulate health check
				const isHealthy = await this.checkInstanceHealth(target.instanceId);
				target.isHealthy = isHealthy;
				target.lastHealthCheck = new Date();

				if (!isHealthy) {
					this.logger.warn('Instance failed health check', {
						instanceId: target.instanceId,
					});
				}
			} catch (error) {
				target.isHealthy = false;
				this.logger.error('Health check error', {
					instanceId: target.instanceId,
					error: error.message,
				});
			}
		}
	}

	private async checkInstanceHealth(instanceId: string): Promise<boolean> {
		// Simulate health check
		const instance = this.instances.get(instanceId);
		return instance ? instance.status === 'running' : false;
	}

	private startHeartbeat(): void {
		this.heartbeatInterval = setInterval(
			() => this.sendHeartbeat(),
			this.config.clustering.heartbeatIntervalMs
		);
	}

	private sendHeartbeat(): void {
		this.currentInstance.lastHeartbeat = new Date();
		this.updateInstanceMetrics();

		// Simulate heartbeat broadcast
		this.logger.debug('Heartbeat sent', {
			instanceId: this.currentInstance.id,
		});
	}

	private updateInstanceMetrics(): void {
		// Update instance metrics
		const usage = process.memoryUsage();
		this.currentInstance.memoryUsage = usage.heapUsed / usage.heapTotal * 100;
		this.currentInstance.cpuUsage = process.cpuUsage().user / 1000000; // Convert to seconds
		this.currentInstance.loadAverage = require('os').loadavg()[0];
	}

	private isInstanceHealthy(instance: InstanceInfo): boolean {
		const now = Date.now();
		const lastHeartbeat = instance.lastHeartbeat.getTime();
		const heartbeatAge = now - lastHeartbeat;
		
		return heartbeatAge < this.config.clustering.suspicionTimeoutMs;
	}

	private setupEventHandlers(): void {
		// Setup event handlers for cluster events
		this.on('leadership-acquired', () => {
			// Start auto-scaling checks if enabled
			if (this.config.autoScaling.enabled) {
				setInterval(() => {
					this.checkAutoScaling().catch(error => {
						this.logger.error('Auto-scaling check failed', { error: error.message });
					});
				}, this.config.autoScaling.cooldownMs);
			}
		});
	}

	// Load balancing selection strategies

	private selectRoundRobin(targets: LoadBalanceTarget[]): LoadBalanceTarget {
		// Simple round-robin (would maintain state for proper round-robin)
		return targets[Math.floor(Math.random() * targets.length)];
	}

	private selectLeastConnections(targets: LoadBalanceTarget[]): LoadBalanceTarget {
		return targets.reduce((min, target) => 
			target.connections < min.connections ? target : min
		);
	}

	private selectWeighted(targets: LoadBalanceTarget[]): LoadBalanceTarget {
		const totalWeight = targets.reduce((sum, target) => sum + target.weight, 0);
		let random = Math.random() * totalWeight;
		
		for (const target of targets) {
			random -= target.weight;
			if (random <= 0) {
				return target;
			}
		}
		
		return targets[0];
	}

	private selectConsistentHash(targets: LoadBalanceTarget[], requestId?: string): LoadBalanceTarget {
		if (!requestId) {
			return targets[0];
		}
		
		const hash = createHash('md5').update(requestId).digest('hex');
		const hashValue = parseInt(hash.substring(0, 8), 16);
		const index = hashValue % targets.length;
		
		return targets[index];
	}

	private async scaleUp(count: number): Promise<void> {
		this.logger.info(`Scaling up by ${count} instances`);
		// In real implementation, this would create new instances
		// For simulation, we'll add placeholder instances
		
		for (let i = 0; i < count; i++) {
			const newInstance: InstanceInfo = {
				...this.currentInstance,
				id: this.generateInstanceId(),
				startedAt: new Date(),
				lastHeartbeat: new Date(),
				isLeader: false,
			};
			
			this.instances.set(newInstance.id, newInstance);
			this.loadBalanceTargets.set(newInstance.id, {
				instanceId: newInstance.id,
				weight: 1,
				connections: 0,
				responseTime: 0,
				isHealthy: true,
				lastHealthCheck: new Date(),
			});
		}
	}

	private async scaleDown(count: number): Promise<void> {
		this.logger.info(`Scaling down by ${count} instances`);
		
		const instances = Array.from(this.instances.values())
			.filter(i => i.status === 'running' && i.id !== this.currentInstance.id)
			.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
		
		const instancesToRemove = instances.slice(-count);
		
		for (const instance of instancesToRemove) {
			this.instances.delete(instance.id);
			this.loadBalanceTargets.delete(instance.id);
		}
	}

	private generateInstanceId(): string {
		return `${this.currentInstance?.type || 'main'}-${randomBytes(8).toString('hex')}`;
	}

	private getLocalIPAddress(): string {
		const { networkInterfaces } = require('os');
		const nets = networkInterfaces();
		
		for (const name of Object.keys(nets)) {
			for (const net of nets[name]) {
				if (net.family === 'IPv4' && !net.internal) {
					return net.address;
				}
			}
		}
		
		return '127.0.0.1';
	}

	private loadConfigFromEnvironment(): void {
		// Load configuration from environment variables
		const envConfig: Partial<MultiMainConfig> = {};

		if (process.env.MULTI_MAIN_ENABLED) {
			envConfig.enabled = process.env.MULTI_MAIN_ENABLED === 'true';
		}
		if (process.env.MULTI_MAIN_COORDINATION_TYPE) {
			envConfig.coordinationType = process.env.MULTI_MAIN_COORDINATION_TYPE as any;
		}
		if (process.env.MULTI_MAIN_LEADER_ELECTION_ENABLED) {
			envConfig.leaderElection = {
				...this.config.leaderElection,
				enabled: process.env.MULTI_MAIN_LEADER_ELECTION_ENABLED === 'true',
			};
		}
		if (process.env.MULTI_MAIN_LOAD_BALANCING_ENABLED) {
			envConfig.loadBalancing = {
				...this.config.loadBalancing,
				enabled: process.env.MULTI_MAIN_LOAD_BALANCING_ENABLED === 'true',
			};
		}
		if (process.env.MULTI_MAIN_AUTO_SCALING_ENABLED) {
			envConfig.autoScaling = {
				...this.config.autoScaling,
				enabled: process.env.MULTI_MAIN_AUTO_SCALING_ENABLED === 'true',
			};
		}

		if (Object.keys(envConfig).length > 0) {
			this.configure(envConfig);
		}
	}
}