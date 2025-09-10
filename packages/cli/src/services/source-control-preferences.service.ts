import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';

export interface SourceControlPreferences {
	enabled: boolean;
	repositoryUrl?: string;
	branchName?: string;
	connected: boolean;
}

@Injectable()
export class SourceControlPreferencesService {
	private readonly logger = new Logger('SourceControlPreferencesService');

	constructor() {
		this.logger.info('Community edition source control preferences service initialized');
	}

	isSourceControlSetup(): boolean {
		// Community edition - source control not available
		return false;
	}

	async getPreferences(): Promise<SourceControlPreferences> {
		return {
			enabled: false,
			connected: false,
		};
	}

	async updatePreferences(preferences: Partial<SourceControlPreferences>): Promise<void> {
		// Community edition - no-op
		this.logger.debug('Source control preferences update attempted (not available in community edition)');
	}
}