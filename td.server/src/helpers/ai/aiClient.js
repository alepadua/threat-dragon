/* eslint-disable */
import axios from 'axios';
import OpenAI from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import loggerHelper from '../logger.helper.js';
import aiContextStore from '../aiContextStore.js';
import { activeJobs } from './activeJobs.js';

const logger = loggerHelper.get('helpers/ai/aiClient.js');
const REQUEST_TIMEOUT = parseInt(process.env.AI_REQUEST_TIMEOUT, 10) || 300000;

export const getProxyAgent = (context = 'general') => {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (proxyUrl) {
        logger.info(`[getProxyAgent] [${context}] Using proxy server configured from environment: ${proxyUrl}`);
        return new HttpsProxyAgent(proxyUrl);
    }
    logger.info(`[getProxyAgent] [${context}] Connecting directly (no proxy detected in environment)`);
    return null;
};

export const parseBase64Image = (dataUri) => {
    const matches = dataUri.match(/^data:(?<mime>[a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(?<data>.+)$/u);
    if (matches && matches.groups) {
        return {
            mimeType: matches.groups.mime,
            data: matches.groups.data
        };
    }
    return {
        mimeType: 'image/png',
        data: dataUri
    };
};

export const clientFactory = {
    getOpenAIClient(aiConfig) {
        const agent = getProxyAgent('OpenAI SDK Fetch');
        const options = {
            apiKey: aiConfig.apiKey,
            baseURL: aiConfig.baseUrl,
            fetch: async (url, init) => {
                const headers = {};
                if (init.headers) {
                    if (typeof init.headers.forEach === 'function') {
                        init.headers.forEach((value, key) => {
                            headers[key] = value;
                        });
                    } else {
                        Object.assign(headers, init.headers);
                    }
                }

                const config = {
                    method: init.method || 'GET',
                    url: url,
                    headers: headers,
                    data: init.body,
                    timeout: init.timeout || 180000,
                    responseType: 'stream',
                    proxy: false
                };

                if (agent) {
                    config.httpAgent = agent;
                    config.httpsAgent = agent;
                }

                try {
                    const res = await axios(config);

                    const readStream = () => new Promise((resolve, reject) => {
                        let data = '';
                        res.data.on('data', (chunk) => {
                            data += chunk.toString('utf8');
                        });
                        res.data.on('end', () => resolve(data));
                        res.data.on('error', (err) => reject(err));
                    });

                    return {
                        ok: res.status >= 200 && res.status < 300,
                        status: res.status,
                        statusText: res.statusText,
                        headers: {
                            get(name) {
                                return res.headers[name.toLowerCase()];
                            },
                            entries() {
                                return Object.entries(res.headers);
                            },
                            [Symbol.iterator]() {
                                return Object.entries(res.headers)[Symbol.iterator]();
                            }
                        },
                        text: readStream,
                        json: async () => {
                            const txt = await readStream();
                            return JSON.parse(txt);
                        },
                        body: res.data
                    };
                } catch (err) {
                    if (err.response) {
                        const readErrStream = () => new Promise((resolve) => {
                            if (typeof err.response.data?.on !== 'function') {
                                resolve(JSON.stringify(err.response.data || ''));
                                return;
                            }
                            let data = '';
                            err.response.data.on('data', (chunk) => {
                                data += chunk.toString('utf8');
                            });
                            err.response.data.on('end', () => resolve(data));
                            err.response.data.on('error', () => resolve(JSON.stringify(err.response.data || '')));
                        });

                        return {
                            ok: false,
                            status: err.response.status,
                            statusText: err.response.statusText,
                            headers: {
                                get(name) {
                                    return err.response.headers[name.toLowerCase()];
                                },
                                entries() {
                                    return Object.entries(err.response.headers);
                                },
                                [Symbol.iterator]() {
                                    return Object.entries(err.response.headers)[Symbol.iterator]();
                                }
                            },
                            text: readErrStream,
                            json: async () => {
                                const txt = await readErrStream();
                                try {
                                    return JSON.parse(txt);
                                } catch {
                                    return txt;
                                }
                            },
                            body: err.response.data
                        };
                    }
                    throw err;
                }
            }
        };
        return new OpenAI(options);
    }
};

export const recoverBedrockMantleResponse = async (promptText, aiConfig) => {
    /* eslint-disable max-depth, no-await-in-loop */
    const listUrl = `${aiConfig.baseUrl}/responses`;
    logger.info(`[recoverBedrockMantleResponse] Attempting to list responses from URL: ${listUrl}`);
    
    const agent = getProxyAgent('Axios Recovery');
    const listAxiosConfig = {
        headers: {
            'Authorization': `Bearer ${aiConfig.apiKey}`,
            'Content-Type': 'application/json'
        },
        params: {
            limit: 5
        },
        timeout: 10000,
        proxy: false
    };
    if (agent) {
        listAxiosConfig.httpAgent = agent;
        listAxiosConfig.httpsAgent = agent;
    }
    
    let listResponse = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            listResponse = await axios.get(listUrl, listAxiosConfig);
            break;
        } catch (listErr) {
            const listErrMessage = listErr?.message || String(listErr);
            logger.warn(`[recoverBedrockMantleResponse] Attempt ${attempt} to list responses from URL ${listUrl} failed: ${listErrMessage}`);
            if (attempt < 3) {
                logger.info(`[recoverBedrockMantleResponse] Wait 2s before retry...`);
                await new Promise((resolve) => { setTimeout(resolve, 2000); });
            } else {
                throw listErr;
            }
        }
    }
    
    if (!listResponse?.data || !Array.isArray(listResponse.data.data) || listResponse.data.data.length === 0) {
        logger.warn(`[recoverBedrockMantleResponse] No recent responses found at URL ${listUrl}`);
        return null;
    }

    const matchingResponse = listResponse.data.data.find((r) => {
        const serializedNormalized = (JSON.stringify(r) || '').toLowerCase().replace(/[^a-z0-9]/gu, '');
        const targetSlice = (promptText || '');
        const promptNormalized = targetSlice.slice(0, Math.min(targetSlice.length, 200)).toLowerCase().
replace(/[^a-z0-9]/gu, '');
        return serializedNormalized.includes(promptNormalized);
    });
    
    if (!matchingResponse) {
        logger.warn(`[recoverBedrockMantleResponse] No matching response found in the recent list for the current prompt.`);
        return null;
    }
    
    let targetResponse = matchingResponse;
    
    if (targetResponse.status === 'in_progress' || targetResponse.status === 'pending') {
        logger.info(`[recoverBedrockMantleResponse] Found matching response ${targetResponse.id} with status ${targetResponse.status}. Polling for completion...`);
        const retrieveUrl = `${aiConfig.baseUrl}/responses/${targetResponse.id}`;
        logger.info(`[recoverBedrockMantleResponse] Attempting to retrieve individual response from URL: ${retrieveUrl}`);
        
        for (let attempt = 1; attempt <= 20; attempt++) {
            await new Promise((resolve) => { setTimeout(resolve, 5000); });
            
            try {
                const retrieveAxiosConfig = {
                    headers: {
                        'Authorization': `Bearer ${aiConfig.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 5000,
                    proxy: false
                };
                if (agent) {
                    retrieveAxiosConfig.httpAgent = agent;
                    retrieveAxiosConfig.httpsAgent = agent;
                }
                const pollResponse = await axios.get(retrieveUrl, retrieveAxiosConfig);
                if (pollResponse?.data) {
                    targetResponse = pollResponse.data;
                    logger.info(`[recoverBedrockMantleResponse] Polling attempt ${attempt} for URL ${retrieveUrl}: status is ${targetResponse.status}`);
                    if (targetResponse.status === 'completed' || targetResponse.status === 'failed') {
                        break;
                    }
                }
            } catch (pollErr) {
                const pollErrMessage = pollErr?.message || String(pollErr);
                logger.error(`[recoverBedrockMantleResponse] Polling attempt ${attempt} failed for URL ${retrieveUrl}: ${pollErrMessage}`);
            }
        }
    }
    
    if (targetResponse.status === 'completed') {
        logger.info(`[recoverBedrockMantleResponse] Successfully recovered timed-out response from Bedrock Mantle. Response ID: ${targetResponse.id}`);
        const content = targetResponse.output?.choices?.[0]?.message?.content || 
                        targetResponse.output?.output_text || 
                        targetResponse.output || '';
        if (content) {
            return content;
        }
    } else {
        logger.warn(`[recoverBedrockMantleResponse] Recovered response ${targetResponse.id} status is ${targetResponse.status}, not completed.`);
    }

    return null;
    /* eslint-enable max-depth, no-await-in-loop */
};

export const callBedrockMantle = async (promptText, images, aiConfig, job = null) => {
    const messages = [];
    let userContent = [];
    if (promptText) {
        userContent.push({ type: 'text', text: promptText });
    }
    if (images && images.length > 0) {
        images.forEach((img) => {
            const parsed = parseBase64Image(img.data || img);
            userContent.push({
                type: 'image_url',
                image_url: { url: `data:${parsed.mimeType};base64,${parsed.data}` }
            });
        });
    }
    
    if (userContent.length === 1 && userContent[0].type === 'text') {
        userContent = userContent[0].text;
    }

    messages.push({ role: 'user', content: userContent });

    const openai = clientFactory.getOpenAIClient(aiConfig);
    logger.info(`[callBedrockMantle] Bedrock Mantle sending chat completion request via OpenAI SDK to URL: ${aiConfig.baseUrl}/chat/completions`);

    const requestPayload = {
        model: aiConfig.model || 'meta.llama3-70b-instruct-v1:0',
        messages: messages,
        max_tokens: 16384,
        stream: true
    };

    if (aiConfig.temperature !== undefined) {
        requestPayload.temperature = Number(aiConfig.temperature);
    }
    if (aiConfig.topP !== undefined) {
        requestPayload.top_p = Number(aiConfig.topP);
    }

    if (aiConfig.extendedThinking) {
        requestPayload.thinking = {
            type: 'enabled',
            budget_tokens: 2048
        };
        requestPayload.reasoning_effort = 'medium';
    }

    try {
        const stream = await openai.chat.completions.create(
            requestPayload,
            {
                timeout: REQUEST_TIMEOUT
            }
        );

        if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
            logger.info(`[callBedrockMantle] Bedrock Mantle stream response initiated. Reading chunks...`);
            let fullContent = '';
            for await (const chunk of stream) {
                const content = chunk.choices?.[0]?.delta?.content || '';
                fullContent += content;
                if (job) {
                    job.streamText = fullContent;
                    activeJobs.set(job.jobId, { ...job });
                }
            }

            logger.info(`[callBedrockMantle] Bedrock Mantle stream response fully received via OpenAI SDK.`);
            return fullContent;
        } 
        logger.info(`[callBedrockMantle] Bedrock Mantle response received (non-stream / test stub).`);
        return stream?.choices?.[0]?.message?.content || '';
        
    } catch (err) {
        const errName = err?.name;
        const errMessage = err?.message;
        
        logger.warn(`[callBedrockMantle] Bedrock Mantle request to ${aiConfig.baseUrl}/chat/completions failed with error: ${errMessage} (${errName}). Attempting to recover response...`);
        try {
            const content = await recoverBedrockMantleResponse(promptText, aiConfig);
            if (content) {
                return content;
            }
        } catch (recoverErr) {
            const recoverErrMessage = recoverErr?.message || String(recoverErr);
            logger.error(`[callBedrockMantle] Failed to recover response: ${recoverErrMessage}`);
        }
        throw err;
    }
};

export const callGemini = async (promptText, images, aiConfig) => {
    const parts = [];
    if (promptText) {
        parts.push({ text: promptText });
    }
    if (images && images.length > 0) {
        images.forEach((img) => {
            const parsed = parseBase64Image(img.data || img);
            parts.push({
                inlineData: { mimeType: parsed.mimeType, data: parsed.data }
            });
        });
    }

    const generationConfig = {
        maxOutputTokens: 16384,
        responseMimeType: 'application/json'
    };

    if (aiConfig.temperature !== undefined) {
        generationConfig.temperature = Number(aiConfig.temperature);
    }
    if (aiConfig.topP !== undefined) {
        generationConfig.topP = Number(aiConfig.topP);
    }

    const payload = {
        contents: [{ parts }],
        generationConfig
    };

    const modelName = aiConfig.model || 'gemini-3.1-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${aiConfig.apiKey}`;
    logger.info(`[callGemini] Gemini sending POST request to API. Payload size: ${JSON.stringify(payload).length} characters`);

    try {
        const response = await axios.post(
            url,
            payload,
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: REQUEST_TIMEOUT
            }
        );

        logger.info(`[callGemini] Gemini response status: ${response.status}`);
        return response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    } catch (err) {
        logger.error(`[callGemini] HTTP/API Request Failed: ${err.message}`);
        if (err.response) {
            logger.error(`[callGemini] Error Response Status: ${err.response.status}`);
            try {
                logger.error(`[callGemini] Error Response Headers: ${JSON.stringify(err.response.headers)}`);
            } catch (e) {
                logger.error(`[callGemini] Error Response Headers: [Could not serialize]`);
            }
            try {
                const data = typeof err.response.data === 'object' && typeof err.response.data?.on === 'function'
                    ? '[Stream - not serializable]'
                    : JSON.stringify(err.response.data);
                logger.error(`[callGemini] Error Response Data: ${data}`);
            } catch (e) {
                logger.error(`[callGemini] Error Response Data: [Could not serialize]`);
            }
        } else if (err.request) {
            logger.error(`[callGemini] Request was sent but no response was received (possible timeout or network error).`);
        }
        throw err;
    }
};

export const callAIModel = async (promptText, images, aiConfig, job = null) => {
    if (job) {
        job.streamText = '';
        activeJobs.set(job.jobId, { ...job });
    }
    if (aiConfig.provider === 'bedrock-mantle') {
        return callBedrockMantle(promptText, images, aiConfig, job);
    }
    return callGemini(promptText, images, aiConfig);
};

export const getEmbeddingsBatch = async (chunks, aiConfig) => {
    if (chunks.length === 0) { return []; }
    const batchSize = 100;
    const allEmbeddings = [];
    
    for (let i = 0; i < chunks.length; i += batchSize) {
        const slice = chunks.slice(i, i + batchSize);
        if (aiConfig.provider === 'bedrock-mantle') {
            const openai = clientFactory.getOpenAIClient(aiConfig);
            /* eslint-disable-next-line no-await-in-loop */
            const response = await openai.embeddings.create({
                model: aiConfig.embeddingModel || 'amazon.titan-embed-text-v1',
                input: slice
            }, {
                timeout: 30000
            });
            if (response && response.data) {
                response.data.forEach((emb) => {
                    allEmbeddings.push(emb.embedding);
                });
            }
        } else {
            const requests = slice.map((chunk) => ({
                model: 'models/gemini-embedding-001',
                content: { parts: [{ text: chunk }] }
            }));
            
            /* eslint-disable-next-line no-await-in-loop */
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${aiConfig.apiKey}`,
                { requests },
                {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 30000
                }
            );
            
            if (response.data && response.data.embeddings) {
                response.data.embeddings.forEach((emb) => {
                    if (emb && emb.values) {
                        allEmbeddings.push(emb.values);
                    }
                });
            }
        }
    }
    return allEmbeddings;
};

export const getEmbedding = async (text, aiConfig) => {
    if (aiConfig.provider === 'bedrock-mantle') {
        const openai = clientFactory.getOpenAIClient(aiConfig);
        const response = await openai.embeddings.create({
            model: aiConfig.embeddingModel || 'amazon.titan-embed-text-v1',
            input: text
        }, {
            timeout: 20000
        });
        if (response && response.data && response.data[0]) {
            return response.data[0].embedding;
        }
    } else {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${aiConfig.apiKey}`,
            {
                model: 'models/gemini-embedding-001',
                content: { parts: [{ text }] }
            },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 20000
            }
        );
        if (response.data && response.data.embedding && response.data.embedding.values) {
            return response.data.embedding.values;
        }
    }
    throw new Error('Failed to generate query embedding');
};

export const cosineSimilarity = (vecA, vecB) => {
    if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) { return 0; }
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) { return 0; }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

export const retrieveContext = async (query, sessionId, aiConfig, topK = 8) => {
    try {
        const chunks = aiContextStore.getVectors(sessionId);
        if (!chunks || chunks.length === 0) {
            logger.info(`No chunks found in vector store for session ${sessionId}`);
            return '';
        }
        
        logger.info(`Retrieving context from local RAG for query: "${query}"`);
        const queryEmbedding = await getEmbedding(query, aiConfig);
        
        const chunksWithScores = chunks.map((chunk) => {
            const score = cosineSimilarity(queryEmbedding, chunk.embedding);
            return { chunk: chunk.text, score };
        });
        
        chunksWithScores.sort((a, b) => b.score - a.score);
        const topChunks = chunksWithScores.slice(0, topK).map((c) => c.chunk);
        
        logger.info(`Retrieved ${topChunks.length} context chunks from vector store.`);
        return topChunks.join('\n\n---\n\n');
    } catch (err) {
        logger.error(`Error retrieving context for query "${query}": ${err.message}`);
        return '';
    }
};

export const getMaxContextChars = (aiConfig) => {
    if (aiConfig?.maxContextTokens) {
        const tokens = Number(aiConfig.maxContextTokens);
        if (!isNaN(tokens) && tokens > 0) {
            const actualTokens = tokens <= 2048 ? tokens * 1000 : tokens;
            return actualTokens * 3;
        }
    }

    const provider = aiConfig?.provider;
    const model = (aiConfig?.model || '').toLowerCase();

    let maxChars = 15000;

    if (provider === 'gemini') {
        maxChars = 600000;
    } else if (provider === 'bedrock-mantle') {
        if (model.includes('llama3.1') || model.includes('llama-3.1')) {
            maxChars = 250000;
        } else if (model.includes('claude-3') || model.includes('claude-v3') || model.includes('sonnet') || model.includes('haiku')) {
            maxChars = 400000;
        } else if (model.includes('meta.llama3') || model.includes('llama3')) {
            maxChars = 15000;
        } else {
            maxChars = 100000;
        }
    }

    return maxChars;
};

export const getQuestionBatchSize = (aiConfig) => {
    if (aiConfig?.questionBatchSize) {
        const size = Number(aiConfig.questionBatchSize);
        if (!isNaN(size) && size > 0) {
            return Math.min(size, 15);
        }
    }

    const maxChars = getMaxContextChars(aiConfig);
    let batchSize = 3;

    if (maxChars >= 600000) {
        batchSize = 8;
    } else if (maxChars >= 250000) {
        batchSize = 5;
    } else if (maxChars >= 100000) {
        batchSize = 4;
    } else {
        batchSize = 3;
    }

    return batchSize;
};

export default {
    getProxyAgent,
    parseBase64Image,
    clientFactory,
    recoverBedrockMantleResponse,
    callBedrockMantle,
    callGemini,
    callAIModel,
    getEmbeddingsBatch,
    getEmbedding,
    cosineSimilarity,
    retrieveContext,
    getMaxContextChars,
    getQuestionBatchSize
};
