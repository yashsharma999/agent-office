/**
 * Verifies each provider can (a) answer and (b) call a tool.
 *
 *   npm run smoke            # tests every preset that has credentials
 *   npm run smoke local dev  # tests just those
 */
import { Agent, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { createModel, describeModel, PRESETS } from './src/model.js';

const weather = tool({
  name: 'get_weather',
  description: 'Get the current temperature in celsius for a city.',
  inputSchema: z.object({ city: z.string() }),
  callback: ({ city }) => ({ city, tempC: 21 }),
});

const requested = process.argv.slice(2);
const presets = requested.length ? requested : Object.keys(PRESETS);
const results = [];

for (const preset of presets) {
  let model;
  try {
    model = createModel({ preset });
  } catch (err) {
    results.push([preset, 'skipped', err.message]);
    continue;
  }

  const label = describeModel(model);
  let toolCalled = false;
  const probe = tool({
    name: 'get_weather',
    description: weather.description,
    inputSchema: z.object({ city: z.string() }),
    callback: ({ city }) => { toolCalled = true; return { city, tempC: 21 }; },
  });

  try {
    console.log(`\n=== ${preset} (${label}) ===`);
    const agent = new Agent({
      model,
      systemPrompt: 'Use the provided tools when relevant. Be brief.',
      tools: [probe],
    });
    await agent.invoke('What is the temperature in Paris right now?');
    results.push([preset, toolCalled ? 'ok (tool called)' : 'answered, no tool call', label]);
  } catch (err) {
    results.push([preset, 'FAILED', err.message.split('\n')[0]]);
  }
}

console.log('\n---------------- summary ----------------');
for (const [preset, status, note] of results) {
  console.log(`${preset.padEnd(7)} ${status.padEnd(24)} ${note}`);
}
