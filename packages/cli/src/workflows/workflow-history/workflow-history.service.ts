// Community Edition Workflow History Service
// Simplified workflow versioning system for community edition

import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';
import type { User, WorkflowEntity } from '@n8n/db';
import { WorkflowRepository } from '@n8n/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';

export interface WorkflowVersion {
	id: string;
	workflowId: string;
	versionNumber: number;
	name: string;
	nodes: any[];
	connections: any;
	settings: Record<string, any>;
	createdAt: Date;
	createdBy: string;
	description?: string;
	tags?: string[];
}

export interface WorkflowHistoryQuery {
	workflowId: string;
	limit?: number;
	offset?: number;
	orderBy?: 'createdAt' | 'versionNumber';
	orderDirection?: 'ASC' | 'DESC';
}

@Injectable()
export class CommunityWorkflowHistoryService {
	constructor(
		private readonly logger: Logger,
		private readonly workflowRepository: WorkflowRepository,
	) {}

	/**
	 * Check if workflow history is enabled (always false in community edition)
	 */
	isEnabled(): boolean {
		return false;
	}

	/**
	 * Save workflow version (basic implementation for community edition)
	 */
	async saveVersion(
		workflow: WorkflowEntity,
		user: User,
		description?: string
	): Promise<string> {
		// In community edition, we provide basic version tracking
		// by storing a simple version counter in workflow settings
		const currentVersion = workflow.settings?.version || 0;
		const newVersion = currentVersion + 1;
		
		await this.workflowRepository.update(workflow.id, {
			settings: {
				...workflow.settings,
				version: newVersion,
				lastUpdatedBy: user.id,
				lastUpdatedAt: new Date(),
				versionHistory: [
					...(workflow.settings?.versionHistory || []).slice(-4), // Keep last 5 versions
					{
						version: newVersion,
						updatedBy: user.id,
						updatedAt: new Date(),
						description: description || 'Workflow updated',
					}
				]
			}
		});

		this.logger.debug(`Saved workflow version ${newVersion} for workflow ${workflow.id}`);
		return `${workflow.id}-v${newVersion}`;
	}

	/**
	 * Get workflow versions (limited implementation in community edition)
	 */
	async getVersions(query: WorkflowHistoryQuery): Promise<WorkflowVersion[]> {
		const workflow = await this.workflowRepository.findOne({
			where: { id: query.workflowId },
		});

		if (!workflow) {
			throw new BadRequestError('Workflow not found');
		}

		// Return basic version info from workflow settings
		const versionHistory = workflow.settings?.versionHistory || [];
		const currentVersion = workflow.settings?.version || 1;
		
		return [
			{
				id: `${workflow.id}-v${currentVersion}`,
				workflowId: workflow.id,
				versionNumber: currentVersion,
				name: workflow.name,
				nodes: workflow.nodes,
				connections: workflow.connections,
				settings: workflow.settings,
				createdAt: workflow.updatedAt,
				createdBy: workflow.settings?.lastUpdatedBy || 'unknown',
				description: 'Current version',
			}
		];
	}

	/**
	 * Get specific workflow version (not available in community edition)
	 */
	async getVersion(versionId: string): Promise<WorkflowVersion | null> {
		throw new BadRequestError('Detailed workflow history is not available in community edition');
	}

	/**
	 * Restore workflow to specific version (not available in community edition)
	 */
	async restoreVersion(workflowId: string, versionId: string, user: User): Promise<void> {
		throw new BadRequestError('Workflow version restoration is not available in community edition');
	}

	/**
	 * Compare two workflow versions (not available in community edition)
	 */
	async compareVersions(versionId1: string, versionId2: string): Promise<any> {
		throw new BadRequestError('Workflow version comparison is not available in community edition');
	}

	/**
	 * Delete workflow version (not available in community edition)
	 */
	async deleteVersion(versionId: string): Promise<void> {
		throw new BadRequestError('Workflow version deletion is not available in community edition');
	}

	/**
	 * Get version count for workflow
	 */
	async getVersionCount(workflowId: string): Promise<number> {
		const workflow = await this.workflowRepository.findOne({
			where: { id: workflowId },
		});

		if (!workflow) {
			return 0;
		}

		return workflow.settings?.version || 1;
	}

	/**
	 * Cleanup old versions (no-op in community edition)
	 */
	async cleanupOldVersions(workflowId: string, keepCount: number = 5): Promise<void> {
		this.logger.debug('Version cleanup is handled automatically in community edition');
	}
}