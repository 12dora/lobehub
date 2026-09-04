import { TraceEventType } from '@lobechat/types';
import { after } from 'next/server';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import { TraceClient } from '@/libs/traces';
import { checkTelemetryEnabled } from '@/libs/trpc/lambda/middleware/telemetry';
import { type TraceEventBasePayload, type TraceEventPayloads } from '@/types/trace';

export const POST = checkAuth(async (req, { serverDB, userId }) => {
  const { telemetryEnabled } = await checkTelemetryEnabled({ serverDB, userId });
  if (!telemetryEnabled) {
    return new Response(undefined, { status: 201 });
  }

  type RequestData = TraceEventPayloads & TraceEventBasePayload;
  const data = (await req.json()) as RequestData;
  const { traceId, eventType } = data;

  const traceClient = new TraceClient();

  const eventClient = traceClient.createEvent(traceId);

  switch (eventType) {
    case TraceEventType.ModifyMessage: {
      eventClient?.modifyMessage(data);
      break;
    }

    case TraceEventType.DeleteAndRegenerateMessage: {
      eventClient?.deleteAndRegenerateMessage(data);
      break;
    }

    case TraceEventType.RegenerateMessage: {
      eventClient?.regenerateMessage(data);
      break;
    }

    case TraceEventType.CopyMessage: {
      eventClient?.copyMessage(data);
      break;
    }
  }

  after(async () => {
    await traceClient.shutdownAsync();
  });

  return new Response(undefined, { status: 201 });
});
