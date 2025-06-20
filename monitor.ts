#!/usr/bin/env node

import { execSync } from 'child_process';
import { createInterface } from 'readline';

interface Block {
  startTime?: string;
  actualEndTime?: string;
  totalTokens: number;
  isGap?: boolean;
  isActive?: boolean;
}

interface CcusageData {
  blocks: Block[];
}

// Store historical burn rates for the mini graph
const burnRateHistory: number[] = [];

function getTerminalWidth(): number {
  return process.stdout.columns || 156;
}

function runCcusage(): CcusageData | null {
  try {
    const result = execSync('ccusage blocks --json', { encoding: 'utf8' });
    return JSON.parse(result);
  } catch (error) {
    console.error(`Error running ccusage: ${error}`);
    return null;
  }
}

function formatTime(minutes: number): string {
  if (minutes < 60) {
    return `${Math.floor(minutes)}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = Math.floor(minutes % 60);
  if (mins === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${mins}m`;
}

function createCompactProgressBar(percentage: number, width: number = 20): string {
  const filled = Math.floor(width * percentage / 100);
  const greenBar = '█'.repeat(filled);
  const redBar = '░'.repeat(width - filled);
  
  const green = '\x1b[92m';
  const red = '\x1b[91m';
  const reset = '\x1b[0m';
  
  return `[${green}${greenBar}${red}${redBar}${reset}]`;
}

function createMiniGraph(history: number[], width: number = 60): string {
  if (history.length === 0) return ' '.repeat(width);
  
  // Use fixed scale instead of dynamic - each bar level represents ~50 tokens/min
  const maxScale = 400; // Top bar = 400 tokens/min
  const bars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  
  let graph = '';
  const startIndex = Math.max(0, history.length - width);
  
  for (let i = startIndex; i < history.length; i++) {
    const rate = history[i];
    const normalized = Math.min(rate / maxScale, 1);
    const barIndex = Math.floor(normalized * (bars.length - 1));
    const color = rate > 200 ? '\x1b[91m' : rate > 100 ? '\x1b[93m' : '\x1b[92m';
    graph += `${color}${bars[barIndex]}\x1b[0m`;
  }
  
  // Pad with spaces if we don't have enough history
  const remaining = width - (history.length - startIndex);
  if (remaining > 0) {
    graph = ' '.repeat(remaining) + graph;
  }
  
  return graph;
}

function getVelocityIndicator(burnRate: number): string {
  if (burnRate < 50) {
    return '🐌';
  } else if (burnRate < 150) {
    return '➡️';
  } else if (burnRate < 300) {
    return '🚀';
  } else {
    return '⚡';
  }
}

function calculateHourlyBurnRate(blocks: Block[], currentTime: Date): number {
  if (!blocks) {
    return 0;
  }
  
  const oneHourAgo = new Date(currentTime.getTime() - 60 * 60 * 1000);
  let totalTokens = 0;
  
  for (const block of blocks) {
    const startTimeStr = block.startTime;
    if (!startTimeStr) {
      continue;
    }
    
    const startTime = new Date(startTimeStr);
    
    if (block.isGap) {
      continue;
    }
    
    let sessionActualEnd: Date;
    if (block.isActive) {
      sessionActualEnd = currentTime;
    } else {
      const actualEndStr = block.actualEndTime;
      if (actualEndStr) {
        sessionActualEnd = new Date(actualEndStr);
      } else {
        sessionActualEnd = currentTime;
      }
    }
    
    if (sessionActualEnd < oneHourAgo) {
      continue;
    }
    
    const sessionStartInHour = startTime > oneHourAgo ? startTime : oneHourAgo;
    const sessionEndInHour = sessionActualEnd < currentTime ? sessionActualEnd : currentTime;
    
    if (sessionEndInHour <= sessionStartInHour) {
      continue;
    }
    
    const totalSessionDuration = (sessionActualEnd.getTime() - startTime.getTime()) / 60000;
    const hourDuration = (sessionEndInHour.getTime() - sessionStartInHour.getTime()) / 60000;
    
    if (totalSessionDuration > 0) {
      const sessionTokens = block.totalTokens || 0;
      const tokensInHour = sessionTokens * (hourDuration / totalSessionDuration);
      totalTokens += tokensInHour;
    }
  }
  
  return totalTokens > 0 ? totalTokens / 60 : 0;
}

function getNextResetTime(currentTime: Date, customResetHour?: number): Date {
  const resetHours = customResetHour !== undefined ? [customResetHour] : [4, 9, 14, 18, 23];
  
  // Work with local time directly
  const localTime = new Date(currentTime);
  const currentHour = localTime.getHours();
  const currentMinute = localTime.getMinutes();
  
  let nextResetHour: number | null = null;
  for (const hour of resetHours) {
    if (currentHour < hour || (currentHour === hour && currentMinute === 0)) {
      nextResetHour = hour;
      break;
    }
  }
  
  let nextResetDate: Date;
  if (nextResetHour === null) {
    nextResetHour = resetHours[0];
    nextResetDate = new Date(localTime);
    nextResetDate.setDate(nextResetDate.getDate() + 1);
  } else {
    nextResetDate = new Date(localTime);
  }
  
  nextResetDate.setHours(nextResetHour, 0, 0, 0);
  
  return nextResetDate;
}

function getTokenLimit(plan: string, blocks?: Block[]): number {
  if (plan === 'custom_max' && blocks) {
    let maxTokens = 0;
    for (const block of blocks) {
      if (!block.isGap && !block.isActive) {
        const tokens = block.totalTokens || 0;
        if (tokens > maxTokens) {
          maxTokens = tokens;
        }
      }
    }
    return maxTokens > 0 ? maxTokens : 7000;
  }
  
  const limits: { [key: string]: number } = {
    'pro': 7000,
    'max5': 35000,
    'max20': 140000
  };
  return limits[plan] || 7000;
}

function clearScreen(): void {
  console.clear();
}

function hideCursor(): void {
  process.stdout.write('\x1b[?25l');
}

function showCursor(): void {
  process.stdout.write('\x1b[?25h');
}

function moveCursorToTop(): void {
  process.stdout.write('\x1b[H');
}

function clearBelowCursor(): void {
  process.stdout.write('\x1b[J');
}

function clearLine(): void {
  process.stdout.write('\x1b[2K\r');
}

function createReadlineInterface() {
  return createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

async function askQuestion(question: string): Promise<string> {
  const rl = createReadlineInterface();
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function showMenu(): Promise<{ plan: string }> {
  console.log('\n🚀 Claude Token Monitor Setup\n');
  console.log('Select your Claude plan:');
  console.log('1. Pro (7,000 tokens)');
  console.log('2. Max5 (35,000 tokens)');
  console.log('3. Max20 (140,000 tokens)');
  console.log('4. Custom Max (auto-detect from usage)');
  console.log();

  let plan = '';
  while (!plan) {
    const choice = await askQuestion('Enter your choice (1-4): ');
    switch (choice.trim()) {
      case '1':
        plan = 'pro';
        break;
      case '2':
        plan = 'max5';
        break;
      case '3':
        plan = 'max20';
        break;
      case '4':
        plan = 'custom_max';
        break;
      default:
        console.log('Invalid choice. Please enter 1, 2, 3, or 4.');
    }
  }

  console.log();
  const useCustomReset = await askQuestion('Use custom reset hour? (y/N): ');
  let resetHour: number | undefined;

  if (useCustomReset.toLowerCase().startsWith('y')) {
    while (resetHour === undefined) {
      const hourInput = await askQuestion('Enter reset hour (0-23): ');
      const hour = parseInt(hourInput.trim());
      if (isNaN(hour) || hour < 0 || hour > 23) {
        console.log('Invalid hour. Please enter a number between 0 and 23.');
      } else {
        resetHour = hour;
      }
    }
  }

  return { plan, resetHour };
}

async function main(): Promise<void> {
  const { plan, resetHour } = await showMenu();
  
  console.log(`\n✅ Plan: ${plan.toUpperCase()}`);
  if (resetHour !== undefined) {
    console.log(`✅ Custom reset hour: ${resetHour}:00`);
  } else {
    console.log('✅ Default reset schedule: 04:00, 09:00, 14:00, 18:00, 23:00');
  }
  console.log('✅ Timezone: System local time');
  console.log('\nStarting monitor in 3 seconds...\n');
  
  await new Promise(resolve => setTimeout(resolve, 3000));

  let tokenLimit: number;
  if (plan === 'custom_max') {
    const initialData = runCcusage();
    if (initialData && initialData.blocks) {
      tokenLimit = getTokenLimit(plan, initialData.blocks);
    } else {
      tokenLimit = getTokenLimit('pro');
    }
  } else {
    tokenLimit = getTokenLimit(plan);
  }

  try {
    clearScreen();
    hideCursor();

    while (true) {
      moveCursorToTop();

      const data = runCcusage();
      if (!data || !data.blocks) {
        console.log("Failed to get usage data");
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }

      let activeBlock: Block | null = null;
      for (const block of data.blocks) {
        if (block.isActive) {
          activeBlock = block;
          break;
        }
      }

      if (!activeBlock) {
        console.log("No active session found");
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }

      const tokensUsed = activeBlock.totalTokens || 0;

      if (tokensUsed > tokenLimit && plan === 'pro') {
        const newLimit = getTokenLimit('custom_max', data.blocks);
        if (newLimit > tokenLimit) {
          tokenLimit = newLimit;
        }
      }

      const usagePercentage = tokenLimit > 0 ? (tokensUsed / tokenLimit) * 100 : 0;
      const tokensLeft = tokenLimit - tokensUsed;

      let elapsedMinutes = 0;
      const startTimeStr = activeBlock.startTime;
      const currentTime = new Date();
      
      if (startTimeStr) {
        const startTime = new Date(startTimeStr);
        const elapsed = currentTime.getTime() - startTime.getTime();
        elapsedMinutes = elapsed / 60000;
      }

      const sessionDuration = 300;
      const remainingMinutes = Math.max(0, sessionDuration - elapsedMinutes);

      const burnRate = calculateHourlyBurnRate(data.blocks, currentTime);
      
      // Update burn rate history (keep last 120 points = 6 minutes at 3-second intervals)
      burnRateHistory.push(burnRate);
      if (burnRateHistory.length > 120) {
        burnRateHistory.shift();
      }

      const resetTime = getNextResetTime(currentTime);

      const timeToReset = resetTime.getTime() - currentTime.getTime();
      const minutesToReset = timeToReset / 60000;

      let predictedEndTime: Date;
      if (burnRate > 0 && tokensLeft > 0) {
        const minutesToDepletion = tokensLeft / burnRate;
        const calculatedEndTime = new Date(currentTime.getTime() + minutesToDepletion * 60000);
        
        // If calculated time is in the past or beyond reset, use reset time
        if (calculatedEndTime <= currentTime) {
          // Past time - tokens should have already run out, use reset time
          predictedEndTime = resetTime;
        } else if (calculatedEndTime > resetTime) {
          // Beyond reset time - tokens will last until reset
          predictedEndTime = resetTime;
        } else {
          // Valid future time before reset
          predictedEndTime = calculatedEndTime;
        }
      } else {
        // No burn rate or no tokens left
        predictedEndTime = resetTime;
      }

      const colors = {
        cyan: '\x1b[96m',
        green: '\x1b[92m',
        blue: '\x1b[94m',
        red: '\x1b[91m',
        yellow: '\x1b[93m',
        white: '\x1b[97m',
        gray: '\x1b[90m',
        reset: '\x1b[0m',
      };

      // Format times
      const resetTimeStr = resetTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
      const predictedEndStr = predictedEndTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
      
      // Status indicators
      const velocityIcon = getVelocityIndicator(burnRate);
      const warningIcon = tokensUsed > tokenLimit ? '🚨' : predictedEndTime < resetTime ? '⚠️' : '✅';
      
      // Compact single-line display
      const progressBar = createCompactProgressBar(usagePercentage);
      const timeStr = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      
      // Get current terminal width and calculate graph size
      const terminalWidth = getTerminalWidth();
      const baseLineLength = `${warningIcon} ${progressBar} Tokens: ${tokensUsed.toLocaleString()}/${tokenLimit.toLocaleString()} (${tokensLeft.toLocaleString()} left) Burn: ${burnRate.toFixed(1)}/min  End: ${predictedEndStr} Reset: ${resetTimeStr} ${timeStr}`.length;
      const availableGraphSpace = Math.max(10, terminalWidth - baseLineLength - 10); // Leave some margin
      
      // Mini graph inline with dynamic sizing
      const graph = createMiniGraph(burnRateHistory, Math.min(40, availableGraphSpace));
      
      const line = `${warningIcon} ${progressBar} Tokens: ${colors.white}${tokensUsed.toLocaleString()}${colors.reset}/${colors.gray}${tokenLimit.toLocaleString()}${colors.reset} (${colors.cyan}${tokensLeft.toLocaleString()} left${colors.reset}) Burn: ${colors.yellow}${burnRate.toFixed(1)}/min${colors.reset} ${graph} End: ${predictedEndStr} Reset: ${resetTimeStr} ${colors.gray}${timeStr}${colors.reset}`;
      
      // Calculate visible length (excluding ANSI codes)
      const visibleLength = line.replace(/\x1b\[[0-9;]*m/g, '').length;
      const borderWidth = Math.max(80, terminalWidth); // Minimum 80 chars, use terminal width if larger
      const padding = ' '.repeat(Math.max(0, borderWidth - 4 - visibleLength));
      
      // ASCII border
      const topBorder = `${colors.cyan}╭${'─'.repeat(borderWidth - 2)}╮${colors.reset}`;
      const bottomBorder = `${colors.cyan}╰${'─'.repeat(borderWidth - 2)}╯${colors.reset}`;
      const paddedLine = `${colors.cyan}│${colors.reset} ${line}${padding} ${colors.cyan}│${colors.reset}`;
      
      console.log(topBorder);
      console.log(paddedLine);
      console.log(bottomBorder);

      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  } catch (error) {
    showCursor();
    if (error instanceof Error && error.message.includes('SIGINT')) {
      console.log(`\n\n${'\x1b[96m'}Monitoring stopped.${'\x1b[0m'}`);
      clearScreen();
      process.exit(0);
    }
    throw error;
  }
}

process.on('SIGINT', () => {
  showCursor();
  console.log(`\n\n${'\x1b[96m'}Monitoring stopped.${'\x1b[0m'}`);
  clearScreen();
  process.exit(0);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    showCursor();
    console.error(error);
    process.exit(1);
  });
}