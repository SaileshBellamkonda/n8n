import { AuthenticatedRequest } from '@n8n/db';
import { RestController, Get, Post, Delete, GlobalScope, Licensed } from '@n8n/decorators';
import express from 'express';
import type {
	MessageEventBusDestinationWebhookOptions,
	MessageEventBusDestinationOptions,
} from 'n8n-workflow';
import { MessageEventBusDestinationTypeNames } from 'n8n-workflow';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';

import { eventNamesAll } from './event-message-classes';
import { MessageEventBus } from './message-event-bus/message-event-bus';

// Event bus destinations are not available in community edition
type MessageEventBusDestination = any;

// Stub functions for enterprise destination checks
const isMessageEventBusDestinationSentryOptions = (candidate: unknown): boolean => false;
const isMessageEventBusDestinationSyslogOptions = (candidate: unknown): boolean => false;

const isWithIdString = (candidate: unknown): candidate is { id: string } => {
	const o = candidate as { id: string };
	if (!o) return false;
	return o.id !== undefined;
};

const isMessageEventBusDestinationWebhookOptions = (
	candidate: unknown,
): candidate is MessageEventBusDestinationWebhookOptions => {
	const o = candidate as MessageEventBusDestinationWebhookOptions;
	if (!o) return false;
	return o.url !== undefined;
};

const isMessageEventBusDestinationOptions = (
	candidate: unknown,
): candidate is MessageEventBusDestinationOptions => {
	const o = candidate as MessageEventBusDestinationOptions;
	if (!o) return false;
	return o.__type !== undefined;
};

@RestController('/eventbus')
export class EventBusController {
	constructor(private readonly eventBus: MessageEventBus) {}

	@Get('/eventnames')
	async getEventNames(): Promise<string[]> {
		return eventNamesAll;
	}

	@Licensed('feat:logStreaming')
	@Get('/destination')
	@GlobalScope('eventBusDestination:list')
	async getDestination(req: express.Request): Promise<MessageEventBusDestinationOptions[]> {
		if (isWithIdString(req.query)) {
			return await this.eventBus.findDestination(req.query.id);
		} else {
			return await this.eventBus.findDestination();
		}
	}

	@Licensed('feat:logStreaming')
	@Post('/destination')
	@GlobalScope('eventBusDestination:create')
	async postDestination(req: AuthenticatedRequest): Promise<any> {
		// Event bus destinations are not available in community edition
		throw new BadRequestError('Event bus destinations are not available in community edition');
	}

	@Licensed('feat:logStreaming')
	@Get('/testmessage')
	@GlobalScope('eventBusDestination:test')
	async sendTestMessage(req: express.Request): Promise<boolean> {
		if (isWithIdString(req.query)) {
			return await this.eventBus.testDestination(req.query.id);
		}
		return false;
	}

	@Licensed('feat:logStreaming')
	@Delete('/destination')
	@GlobalScope('eventBusDestination:delete')
	async deleteDestination(req: AuthenticatedRequest) {
		if (isWithIdString(req.query)) {
			await this.eventBus.removeDestination(req.query.id);
			return await this.eventBus.deleteDestination(req.query.id);
		} else {
			throw new BadRequestError('Query is missing id');
		}
	}
}
