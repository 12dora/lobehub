import { Hono } from 'hono';

import { webapiModuleGate } from '@/server/enterprise/guards/webapiModuleGate';

import agentSignalApp from './agent-signal';
import memoryUserMemoryApp from './memory-user-memory';
import taskApp from './task';
import verifyApp from './verify';

const app = new Hono().basePath('/api/workflows');

app.use('*', webapiModuleGate);

app.route('/agent-signal', agentSignalApp);
app.route('/memory-user-memory', memoryUserMemoryApp);
app.route('/task', taskApp);
app.route('/verify', verifyApp);

export default app;
