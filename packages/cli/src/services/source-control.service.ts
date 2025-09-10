import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';

export interface SourceControlStatus {
	ahead: number;
	behind: number;
	conflicted: string[];
	created: string[];
	deleted: string[];
	modified: string[];
	renamed: string[];
	staged: string[];
}

@Injectable()
export class SourceControlService {
	private readonly logger = new Logger('SourceControlService');

	constructor() {
		this.logger.info('Community edition source control service initialized');
	}

	async getStatus(): Promise<SourceControlStatus> {
		// Community edition - return empty status
		return {
			ahead: 0,
			behind: 0,
			conflicted: [],
			created: [],
			deleted: [],
			modified: [],
			renamed: [],
			staged: [],
		};
	}

	async pull(): Promise<void> {
		// Community edition - no-op
		this.logger.debug('Source control pull attempted (not available in community edition)');
	}

	async push(): Promise<void> {
		// Community edition - no-op
		this.logger.debug('Source control push attempted (not available in community edition)');
	}

	async disconnect(): Promise<void> {
		// Community edition - no-op
		this.logger.debug('Source control disconnect attempted (not available in community edition)');
	}
}