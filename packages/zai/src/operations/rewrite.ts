// eslint-disable consistent-type-definitions
import { z } from '@bpinternal/zui'

import { fastHash, stringify, takeUntilTokens } from '../utils'
import { Zai } from '../zai'
import { PROMPT_INPUT_BUFFER } from './constants'

type Example = {
  input: string
  output: string
  instructions?: string
}

const _Example = z.object({
  input: z.string(),
  output: z.string(),
})

export type Options = {
  /** Examples to guide the rewriting */
  examples?: Array<Example>
  /** The maximum number of tokens to generate */
  length?: number
}

const Options = z.object({
  examples: z.array(_Example).default([]),
  length: z.number().min(10).max(16_000).optional().describe('The maximum number of tokens to generate'),
})

declare module '@botpress/zai' {
  interface Zai {
    /** Rewrites a string according to match the prompt */
    rewrite(original: string, prompt: string, options?: Options): Promise<string>
  }
}

const START = '■START■'
const END = '■END■'

Zai.prototype.rewrite = async function (this: Zai, original, prompt, _options) {
  const options = Options.parse(_options ?? {}) as Options
  const tokenizer = await this.getTokenizer()
  await this.fetchModelDetails()

  const taskId = this.taskId
  const taskType = 'zai.rewrite'

  const INPUT_COMPONENT_SIZE = Math.max(100, (this.ModelDetails.input.maxTokens - PROMPT_INPUT_BUFFER) / 2)
  prompt = tokenizer.truncate(prompt, INPUT_COMPONENT_SIZE)

  const inputSize = tokenizer.count(original) + tokenizer.count(prompt)
  const maxInputSize = this.ModelDetails.input.maxTokens - tokenizer.count(prompt) - PROMPT_INPUT_BUFFER
  if (inputSize > maxInputSize) {
    throw new Error(
      `The input size is ${inputSize} tokens long, which is more than the maximum of ${maxInputSize} tokens for this model (${this.ModelDetails.name} = ${this.ModelDetails.input.maxTokens} tokens)`
    )
  }

  const instructions: string[] = []

  const originalSize = tokenizer.count(original)
  if (options.length && originalSize > options.length) {
    instructions.push(`The original text is ${originalSize} tokens long – it should be less than ${options.length}`)
    instructions.push(
      `The text must be standalone and complete in less than ${options.length} tokens, so it has to be shortened to fit the length as well`
    )
  }

  const format = (before: string, prompt: string) => {
    return `
Prompt: ${prompt}

${START}
${before}
${END}
`.trim()
  }

  const Key = fastHash(
    stringify({
      taskId,
      taskType,
      input: original,
      prompt,
    })
  )

  const formatExample = ({ input, output, instructions }: Example) => {
    return [
      { type: 'text' as const, role: 'user' as const, content: format(input, instructions || prompt) },
      { type: 'text' as const, role: 'assistant' as const, content: `${START}${output}${END}` },
    ]
  }

  const defaultExamples: Example[] = [
    { input: 'Hello, how are you?', output: 'Bonjour, comment ça va?', instructions: 'translate to French' },
    { input: '1\n2\n3', output: '3\n2\n1', instructions: 'reverse the order' },
  ]

  const tableExamples = taskId
    ? await this.adapter.getExamples<string, string>({
        input: original,
        taskId,
        taskType,
      })
    : []

  const exactMatch = tableExamples.find((x) => x.key === Key)
  if (exactMatch) {
    return exactMatch.output
  }

  const savedExamples: Example[] = [
    ...tableExamples.map((x) => ({ input: x.input as string, output: x.output as string }) satisfies Example),
    ...options.examples,
  ]

  const REMAINING_TOKENS = this.ModelDetails.input.maxTokens - tokenizer.count(prompt) - PROMPT_INPUT_BUFFER
  const examples = takeUntilTokens(
    savedExamples.length ? savedExamples : defaultExamples,
    REMAINING_TOKENS,
    (el) => tokenizer.count(stringify(el.input)) + tokenizer.count(stringify(el.output))
  )
    .map(formatExample)
    .flat()

  const { output, meta } = await this.callModel({
    systemPrompt: `
Rewrite the text between the ${START} and ${END} tags to match the user prompt.
${instructions.map((x) => `• ${x}`).join('\n')}
`.trim(),
    messages: [...examples, { type: 'text', content: format(original, prompt), role: 'user' }],
    maxTokens: options.length,
    stopSequences: [END],
  })

  let result = output.choices[0]?.content as string

  if (result.includes(START)) {
    result = result.slice(result.indexOf(START) + START.length)
  }

  if (result.includes(END)) {
    result = result.slice(0, result.indexOf(END))
  }

  if (taskId) {
    await this.adapter.saveExample({
      key: Key,
      metadata: {
        cost: {
          input: meta.cost.input,
          output: meta.cost.output,
        },
        latency: meta.latency,
        model: this.Model,
        tokens: {
          input: meta.tokens.input,
          output: meta.tokens.output,
        },
      },
      instructions: prompt,
      input: original,
      output: result,
      taskType,
      taskId,
    })
  }

  return result
}
