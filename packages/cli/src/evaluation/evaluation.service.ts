// Community Edition Evaluation Service
// Simple workflow testing and evaluation for community edition

import { Injectable } from '@n8n/di';
import { Logger } from '@n8n/backend-common';
import type { WorkflowEntity, User } from '@n8n/db';
import { WorkflowRepository } from '@n8n/db';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';

export interface EvaluationTest {
	id: string;
	name: string;
	workflowId: string;
	testData: any;
	expectedOutput: any;
	createdAt: Date;
	createdBy: string;
}

export interface EvaluationResult {
	testId: string;
	passed: boolean;
	executionTime: number;
	actualOutput: any;
	errors?: string[];
	metrics?: Record<string, number>;
}

export interface EvaluationRun {
	id: string;
	workflowId: string;
	testIds: string[];
	status: 'pending' | 'running' | 'completed' | 'failed';
	results: EvaluationResult[];
	startedAt: Date;
	completedAt?: Date;
	runBy: string;
}

export interface EvaluationMetrics {
	totalTests: number;
	passedTests: number;
	failedTests: number;
	averageExecutionTime: number;
	successRate: number;
}

@Injectable()
export class CommunityEvaluationService {
	private tests: Map<string, EvaluationTest> = new Map();
	private runs: Map<string, EvaluationRun> = new Map();

	constructor(
		private readonly logger: Logger,
		private readonly workflowRepository: WorkflowRepository,
	) {}

	/**
	 * Check if evaluation is enabled (limited in community edition)
	 */
	isEnabled(): boolean {
		return true; // Basic evaluation is available
	}

	/**
	 * Create a new test for workflow
	 */
	async createTest(
		workflowId: string,
		testName: string,
		testData: any,
		expectedOutput: any,
		user: User
	): Promise<string> {
		const testId = `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
		
		const test: EvaluationTest = {
			id: testId,
			name: testName,
			workflowId,
			testData,
			expectedOutput,
			createdAt: new Date(),
			createdBy: user.id,
		};

		this.tests.set(testId, test);
		this.logger.debug(`Created evaluation test ${testId} for workflow ${workflowId}`);
		
		return testId;
	}

	/**
	 * Get tests for workflow
	 */
	async getTests(workflowId: string): Promise<EvaluationTest[]> {
		const tests = Array.from(this.tests.values())
			.filter(test => test.workflowId === workflowId);
		
		return tests;
	}

	/**
	 * Get specific test
	 */
	async getTest(testId: string): Promise<EvaluationTest | null> {
		return this.tests.get(testId) || null;
	}

	/**
	 * Update test
	 */
	async updateTest(
		testId: string,
		updates: Partial<Pick<EvaluationTest, 'name' | 'testData' | 'expectedOutput'>>
	): Promise<void> {
		const test = this.tests.get(testId);
		if (!test) {
			throw new BadRequestError('Test not found');
		}

		Object.assign(test, updates);
		this.tests.set(testId, test);
	}

	/**
	 * Delete test
	 */
	async deleteTest(testId: string): Promise<void> {
		this.tests.delete(testId);
	}

	/**
	 * Run evaluation tests for workflow
	 */
	async runEvaluation(workflowId: string, testIds: string[], user: User): Promise<string> {
		const runId = `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
		
		const evaluationRun: EvaluationRun = {
			id: runId,
			workflowId,
			testIds,
			status: 'pending',
			results: [],
			startedAt: new Date(),
			runBy: user.id,
		};

		this.runs.set(runId, evaluationRun);

		// Run tests asynchronously
		this.executeTests(runId).catch(error => {
			this.logger.error(`Evaluation run ${runId} failed:`, error);
			const run = this.runs.get(runId);
			if (run) {
				run.status = 'failed';
				run.completedAt = new Date();
			}
		});

		return runId;
	}

	/**
	 * Get evaluation run
	 */
	async getRun(runId: string): Promise<EvaluationRun | null> {
		return this.runs.get(runId) || null;
	}

	/**
	 * Get evaluation runs for workflow
	 */
	async getRuns(workflowId: string): Promise<EvaluationRun[]> {
		return Array.from(this.runs.values())
			.filter(run => run.workflowId === workflowId)
			.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
	}

	/**
	 * Get evaluation metrics for workflow
	 */
	async getMetrics(workflowId: string): Promise<EvaluationMetrics> {
		const runs = await this.getRuns(workflowId);
		const completedRuns = runs.filter(run => run.status === 'completed');
		
		if (completedRuns.length === 0) {
			return {
				totalTests: 0,
				passedTests: 0,
				failedTests: 0,
				averageExecutionTime: 0,
				successRate: 0,
			};
		}

		const allResults = completedRuns.flatMap(run => run.results);
		const totalTests = allResults.length;
		const passedTests = allResults.filter(result => result.passed).length;
		const failedTests = totalTests - passedTests;
		const averageExecutionTime = allResults.reduce((sum, result) => sum + result.executionTime, 0) / totalTests;
		const successRate = totalTests > 0 ? (passedTests / totalTests) * 100 : 0;

		return {
			totalTests,
			passedTests,
			failedTests,
			averageExecutionTime,
			successRate,
		};
	}

	/**
	 * Execute tests for evaluation run
	 */
	private async executeTests(runId: string): Promise<void> {
		const run = this.runs.get(runId);
		if (!run) {
			throw new BadRequestError('Evaluation run not found');
		}

		run.status = 'running';
		
		try {
			for (const testId of run.testIds) {
				const test = this.tests.get(testId);
				if (!test) {
					continue;
				}

				const result = await this.executeTest(test);
				run.results.push(result);
			}

			run.status = 'completed';
			run.completedAt = new Date();
			
		} catch (error) {
			run.status = 'failed';
			run.completedAt = new Date();
			throw error;
		}
	}

	/**
	 * Execute single test
	 */
	private async executeTest(test: EvaluationTest): Promise<EvaluationResult> {
		const startTime = Date.now();
		
		try {
			// In community edition, we provide basic test execution
			// This is a simplified implementation that compares test data with expected output
			const actualOutput = this.simulateWorkflowExecution(test.testData);
			const passed = this.compareOutputs(actualOutput, test.expectedOutput);
			const executionTime = Date.now() - startTime;

			return {
				testId: test.id,
				passed,
				executionTime,
				actualOutput,
				metrics: {
					executionTime,
				},
			};
		} catch (error) {
			return {
				testId: test.id,
				passed: false,
				executionTime: Date.now() - startTime,
				actualOutput: null,
				errors: [error.message],
			};
		}
	}

	/**
	 * Simulate workflow execution (simplified for community edition)
	 */
	private simulateWorkflowExecution(testData: any): any {
		// This is a simplified simulation
		// In a real implementation, this would execute the workflow with the test data
		return {
			success: true,
			data: testData,
			timestamp: new Date(),
		};
	}

	/**
	 * Compare actual output with expected output
	 */
	private compareOutputs(actual: any, expected: any): boolean {
		// Simple comparison - in real implementation this would be more sophisticated
		try {
			return JSON.stringify(actual) === JSON.stringify(expected);
		} catch {
			return actual === expected;
		}
	}
}