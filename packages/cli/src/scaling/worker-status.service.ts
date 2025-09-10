import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';

export interface WorkerStatus {
	id: string;
	status: 'active' | 'idle' | 'busy' | 'stopped';
	lastPing: Date;
	load: number;
	jobs: number;
	version: string;
}

@Injectable()
export class WorkerStatusService {
	private readonly logger = new Logger('WorkerStatusService');

	constructor() {
		this.logger.info('Community edition worker status service initialized');
	}

	async updateStatus(status: WorkerStatus): Promise<void> {
		// Community edition implementation - basic status tracking
		this.logger.debug('Worker status updated', { workerId: status.id, status: status.status });
	}

	async getWorkerStatus(workerId: string): Promise<WorkerStatus | null> {
		// Community edition implementation - basic status retrieval
		return {
			id: workerId,
			status: 'active',
			lastPing: new Date(),
			load: 0,
			jobs: 0,
			version: '1.0.0',
		};
	}

	async getAllWorkerStatuses(): Promise<WorkerStatus[]> {
		// Community edition implementation - return empty array
		return [];
	}

	async removeWorker(workerId: string): Promise<void> {
		// Community edition implementation - no-op
		this.logger.debug('Worker removed from status tracking', { workerId });
	}
}