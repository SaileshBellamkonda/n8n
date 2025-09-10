import { Logger } from '@n8n/backend-common';
import type { EventDestinations } from '@n8n/db';
import { Container } from '@n8n/di';
import { MessageEventBusDestinationTypeNames } from 'n8n-workflow';

import type { MessageEventBus } from '../message-event-bus/message-event-bus';

// Event bus destinations are not available in community edition  
export function messageEventBusDestinationFromDb(
	eventBusInstance: MessageEventBus,
	dbData: EventDestinations,
): any | null {
	Container.get(Logger).warn('Event bus destinations are not available in community edition');
	return null;
}
