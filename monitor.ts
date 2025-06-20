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

function createTokenProgressBar(percentage: number, width: number = 50): string {
  const filled = Math.floor(width * percentage / 100);
  
  const greenBar = '█'.repeat(filled);
  const redBar = '░'.repeat(width - filled);
  
  const green = '\x1b[92m';
  const red = '\x1b[91m';
  const reset = '\x1b[0m';

  // green, yellow at 75%, orange at 85%, red at 95%
  let stateIcon = '🟢'
  if (percentage >= 95) {
    stateIcon = '🔴'; 
  } else if (percentage >= 85) {
    stateIcon = '🟠'; 
  } else if (percentage >= 75) {
    stateIcon = '🟡'; 
  }
  
  return `${stateIcon} [${green}${greenBar}${red}${redBar}${reset}] ${percentage.toFixed(1)}%`;
}

function createTimeProgressBar(elapsedMinutes: number, totalMinutes: number, width: number = 50): string {
  const percentage = totalMinutes <= 0 ? 0 : Math.min(100, (elapsedMinutes / totalMinutes) * 100);
  const filled = Math.floor(width * percentage / 100);
  
  const blueBar = '█'.repeat(filled);
  const redBar = '░'.repeat(width - filled);
  
  const blue = '\x1b[94m';
  const red = '\x1b[91m';
  const reset = '\x1b[0m';
  
  const remainingTime = formatTime(Math.max(0, totalMinutes - elapsedMinutes));
  return `⏰ [${blue}${blueBar}${red}${redBar}${reset}] ${remainingTime}`;
}

function printHeader(): void {
  const cyan = '\x1b[96m';
  const blue = '\x1b[94m';
  const reset = '\x1b[0m';
  
  const sparkles = `${cyan}✦ ✧ ✦ ✧ ${reset}`;
  
  console.log(`${sparkles}${cyan}CLAUDE TOKEN MONITOR${reset} ${sparkles}`);
  console.log(`${blue}${'='.repeat(60)}${reset}`);
  console.log();
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

async function showMenu(): Promise<{ plan: string; resetHour?: number; displayMode: string }> {
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

  console.log();
  console.log('Select display mode:');
  console.log('1. Verbose (full multi-line display)');
  console.log('2. Minimal (compact single-line with border)');
  console.log();

  let displayMode = '';
  while (!displayMode) {
    const choice = await askQuestion('Enter display mode (1-2): ');
    switch (choice.trim()) {
      case '1':
        displayMode = 'verbose';
        break;
      case '2':
        displayMode = 'minimal';
        break;
      default:
        console.log('Invalid choice. Please enter 1 or 2.');
    }
  }

  return { plan, resetHour, displayMode };
}

async function main(): Promise<void> {
  const { plan, resetHour, displayMode } = await showMenu();
  
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

      const currentTime = new Date();
      const burnRate = calculateHourlyBurnRate(data.blocks, currentTime);
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

      // Time math
      const timeSinceReset = Math.max(0, 300 - minutesToReset); 
      const today = new Date();
      const isToday = (date: Date) => {
        return date.getDate() === today.getDate() &&
               date.getMonth() === today.getMonth() &&
               date.getFullYear() === today.getFullYear();
      };
      const predictedEndStr = predictedEndTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
      const resetTimeStr = resetTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
      const predictedDisplay = isToday(predictedEndTime) 
        ? predictedEndStr 
        : `${predictedEndStr} (${predictedEndTime.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})`;
      const resetDisplay = isToday(resetTime) 
        ? resetTimeStr 
        : `${resetTimeStr} (${resetTime.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})`;

      if (displayMode === 'minimal') {
        // Minimal display mode with border
        const terminalWidth = getTerminalWidth();
        const progressBar = createTokenProgressBar(usagePercentage, 15);
        const timeToResetBar = createTimeProgressBar(timeSinceReset, 300, 15);
        const line = ``+
          `📊 ${colors.white}Token Usage:${colors.reset} ${progressBar}  ` 
        + `⏳ ${colors.white}Time to Reset:${colors.reset} ${timeToResetBar}  ` 
        + `🏁 ${colors.white}Predicted End:${colors.reset} ${predictedDisplay}  ` 
        + `🔄 ${colors.white}Token Reset:${colors.reset} ${resetDisplay}`
        
        const visibleLength = line.replace(/\x1b\[[0-9;]*m/g, '').length;
        const borderWidth = Math.max(80, terminalWidth);
        const padding = ' '.repeat(Math.max(0, borderWidth - 6 - visibleLength));
        
        const topBorder = `${colors.cyan}╭${'─'.repeat(borderWidth - 2)}╮${colors.reset}`;
        const bottomBorder = `${colors.cyan}╰${'─'.repeat(borderWidth - 2)}╯${colors.reset}`;
        const paddedLine = `${colors.cyan}│${colors.reset} ${line}${padding} ${colors.cyan}│${colors.reset}`;
        
        console.log(topBorder);
        console.log(paddedLine);
        console.log(bottomBorder);
      } else {
        // Verbose display mode (original)
        printHeader();

        console.log(`📊 ${colors.white}Token Usage:${colors.reset}    ${createTokenProgressBar(usagePercentage)}`);
        console.log();

        console.log(`⏳ ${colors.white}Time to Reset:${colors.reset}  ${createTimeProgressBar(timeSinceReset, 300)}`);
        console.log();

        console.log(`🎯 ${colors.white}Tokens:${colors.reset}         ${colors.white}${tokensUsed.toLocaleString()}${colors.reset} / ${colors.gray}~${tokenLimit.toLocaleString()}${colors.reset} (${colors.cyan}${tokensLeft.toLocaleString()} left${colors.reset})`);
        console.log(`🔥 ${colors.white}Burn Rate:${colors.reset}      ${colors.yellow}${burnRate.toFixed(1)}${colors.reset} ${colors.gray}tokens/min${colors.reset}`);
        console.log();

        console.log(`🏁 ${colors.white}Predicted End:${colors.reset} ${predictedDisplay}`);
        console.log(`🔄 ${colors.white}Token Reset:${colors.reset}   ${resetDisplay}`);
        console.log();

        const showSwitchNotification = tokensUsed > 7000 && plan === 'pro' && tokenLimit > 7000;
        const showExceedNotification = tokensUsed > tokenLimit;

        if (showSwitchNotification) {
          console.log(`🔄 ${colors.yellow}Tokens exceeded Pro limit - switched to custom_max (${tokenLimit.toLocaleString()})${colors.reset}`);
          console.log();
        }

        if (showExceedNotification) {
          console.log(`🚨 ${colors.red}TOKENS EXCEEDED MAX LIMIT! (${tokensUsed.toLocaleString()} > ${tokenLimit.toLocaleString()})${colors.reset}`);
          console.log();
        }

        if (predictedEndTime < resetTime) {
          console.log(`⚠️  ${colors.red}Tokens will run out BEFORE reset!${colors.reset}`);
          console.log();
        }

        const currentTimeStr = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        console.log(`⏰ ${colors.gray}${currentTimeStr}${colors.reset} 📝 ${colors.cyan}Smooth sailing...${colors.reset} | ${colors.gray}Ctrl+C to exit${colors.reset} 🟨`);
      }

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
