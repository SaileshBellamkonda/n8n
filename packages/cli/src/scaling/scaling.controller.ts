// Community Edition Scaling Controller
// Simple scaling management interface for community edition

import { RestController, Get, Post, Put, Delete, GlobalScope } from '@n8n/decorators';
import { AuthenticatedRequest } from '@n8n/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';

export interface WorkerInfo {
	id: string;
	type: 'main' | 'worker';
	status: 'active' | 'inactive' | 'busy';
	activeExecutions: number;
	lastSeen: Date;
	cpuUsage?: number;
	memoryUsage?: number;
}

export interface ScalingStatus {
	multiMainEnabled: boolean;
	totalWorkers: number;
	activeWorkers: number;
	maxWorkers: number;
	autoScalingEnabled: boolean;
	loadBalancingEnabled: boolean;
}

@RestController('/scaling')
export class CommunityScalingController {
	/**
	 * Get scaling status
	 */
	@Get('/status')
	@GlobalScope('settings:read')
	getScalingStatus(): ScalingStatus {
		return {
			multiMainEnabled: false,
			totalWorkers: 1,
			activeWorkers: 1,
			maxWorkers: 1,
			autoScalingEnabled: false,
			loadBalancingEnabled: false,
		};
	}

	/**
	 * Get all workers
	 */
	@Get('/workers')
	@GlobalScope('settings:read')
	getWorkers(): WorkerInfo[] {
		return [
			{
				id: 'main-worker',
				type: 'main',
				status: 'active',
				activeExecutions: 0,
				lastSeen: new Date(),
				cpuUsage: 0,
				memoryUsage: 0,
			}
		];
	}

	/**
	 * Get specific worker
	 */
	@Get('/workers/:workerId')
	@GlobalScope('settings:read')
	getWorker(req: AuthenticatedRequest): WorkerInfo {
		const { workerId } = req.params;
		
		if (workerId === 'main-worker') {
			return {
				id: 'main-worker',
				type: 'main',
				status: 'active',
				activeExecutions: 0,
				lastSeen: new Date(),
				cpuUsage: 0,
				memoryUsage: 0,
			};
		}

		throw new BadRequestError('Worker not found');
	}

	/**
	 * Add worker (not available in community edition)
	 */
	@Post('/workers')
	@GlobalScope('settings:update')
	addWorker(): never {
		throw new BadRequestError('Adding workers is not available in community edition');
	}

	/**
	 * Remove worker (not available in community edition)
	 */
	@Delete('/workers/:workerId')
	@GlobalScope('settings:update')
	removeWorker(): never {
		throw new BadRequestError('Removing workers is not available in community edition');
	}

	/**
	 * Scale workers (not available in community edition)
	 */
	@Put('/workers/scale')
	@GlobalScope('settings:update')
	scaleWorkers(): never {
		throw new BadRequestError('Worker scaling is not available in community edition');
	}

	/**
	 * Enable auto-scaling (not available in community edition)
	 */
	@Post('/auto-scaling/enable')
	@GlobalScope('settings:update')
	enableAutoScaling(): never {
		throw new BadRequestError('Auto-scaling is not available in community edition');
	}

	/**
	 * Disable auto-scaling (not available in community edition)
	 */
	@Post('/auto-scaling/disable')
	@GlobalScope('settings:update')
	disableAutoScaling(): never {
		throw new BadRequestError('Auto-scaling is not available in community edition');
	}

	/**
	 * Enable load balancing (not available in community edition)
	 */
	@Post('/load-balancing/enable')
	@GlobalScope('settings:update')
	enableLoadBalancing(): never {
		throw new BadRequestError('Load balancing is not available in community edition');
	}

	/**
	 * Disable load balancing (not available in community edition)
	 */
	@Post('/load-balancing/disable')
	@GlobalScope('settings:update')
	disableLoadBalancing(): never {
		throw new BadRequestError('Load balancing is not available in community edition');
	}

	/**
	 * Get scaling metrics
	 */
	@Get('/metrics')
	@GlobalScope('settings:read')
	getScalingMetrics() {
		return {
			totalWorkers: 1,
			activeWorkers: 1,
			busyWorkers: 0,
			totalExecutions: 0,
			averageExecutionTime: 0,
			cpuUsage: 0,
			memoryUsage: 0,
			queueSize: 0,
			throughput: 0,
		};
	}

	/**
	 * Get worker health status
	 */
	@Get('/health')
	@GlobalScope('settings:read')
	getWorkerHealth() {
		return {
			'main-worker': {
				status: 'healthy',
				lastSeen: new Date(),
				uptime: process.uptime(),
			}
		};
	}
}