/**
 * CLI entry point.
 *
 *   npm run dev "what time is it in Tokyo?"     one-shot
 *   npm run dev                                  interactive chat
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createAgent } from './src/agent.js';
import { describeModel } from './src/model.js';

const agent = createAgent();
console.log(`Model: ${describeModel(agent.model)}\n`);

const oneShot = process.argv.slice(2).join(' ').trim();

if (oneShot) {
  await agent.invoke(oneShot);
  console.log();
} else {
  // Interactive mode. The Agent keeps conversation history across invokes,
  // so follow-up questions like "and in UTC?" work.
  const rl = createInterface({ input: stdin, output: stdout });
  console.log('Chat started. Type "exit" to quit.\n');
  while (true) {
    const line = (await rl.question('you > ')).trim();
    if (!line) continue;
    if (['exit', 'quit', 'bye'].includes(line.toLowerCase())) break;
    process.stdout.write('\n');
    await agent.invoke(line);
    process.stdout.write('\n\n');
  }
  rl.close();
}
