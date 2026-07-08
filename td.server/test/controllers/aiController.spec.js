import { expect } from 'chai';
import sinon from 'sinon';
import axios from 'axios';
import aiController from '../../src/controllers/aiController.js';
import aiContextStore from '../../src/helpers/aiContextStore.js';

describe('controllers/aiController.js - Semantic Similarity & Merging', () => {
    describe('_areTitlesSimilar', () => {
        it('should return true for semantically similar Portuguese titles', () => {
            const t1 = "Comprometimento por credenciais estáticas";
            const t2 = "Uso de credenciais estáticas sem rotação";
            expect(aiController._areTitlesSimilar(t1, t2)).to.be.true;
        });

        it('should return true when diacritics/accents are different', () => {
            const t1 = "Comprometimento por credenciais estáticas";
            const t2 = "comprometimento por credenciais estaticas";
            expect(aiController._areTitlesSimilar(t1, t2)).to.be.true;
        });

        it('should return false for completely different threats', () => {
            const t1 = "Acesso direto e falta de segregação";
            const t2 = "Exposição pública do SQL";
            expect(aiController._areTitlesSimilar(t1, t2)).to.be.false;
        });
    });

    describe('_mergeDiagramCells', () => {
        it('should merge semantically similar threats instead of duplicating them', () => {
            const currentModel = {
                detail: {
                    diagrams: [{
                        diagramType: 'STRIDE',
                        cells: [
                            {
                                id: 'cell-1',
                                shape: 'store',
                                data: {
                                    name: 'Azure SQL Database',
                                    threats: [
                                        {
                                            id: 'threat-1',
                                            title: 'Comprometimento por credenciais estáticas',
                                            description: 'Old description',
                                            mitigation: 'Old mitigation',
                                            status: 'Open',
                                            severity: 'Critical'
                                        }
                                    ]
                                }
                            }
                        ]
                    }]
                }
            };

            const revisedModel = {
                detail: {
                    diagrams: [{
                        diagramType: 'STRIDE',
                        cells: [
                            {
                                id: 'cell-1',
                                shape: 'store',
                                data: {
                                    name: 'Azure SQL Database',
                                    threats: [
                                        {
                                            title: 'Uso de credenciais estáticas sem rotação',
                                            description: 'New updated description',
                                            mitigation: 'New updated mitigation',
                                            status: 'Open',
                                            severity: 'High'
                                        }
                                    ]
                                }
                            }
                        ]
                    }]
                }
            };

            const merged = aiController._mergeDiagramCells(currentModel, revisedModel, [], true);
            const mergedCells = merged.detail.diagrams[0].cells;
            
            // Should still have only 1 threat (because the new one was merged into the similar existing one)
            expect(mergedCells[0].data.threats).to.have.lengthOf(1);
            
            const mergedThreat = mergedCells[0].data.threats[0];
            expect(mergedThreat.id).to.equal('threat-1');
            expect(mergedThreat.title).to.equal('Uso de credenciais estáticas sem rotação');
            expect(mergedThreat.description).to.equal('New updated description');
            expect(mergedThreat.mitigation).to.equal('New updated mitigation');
            expect(mergedThreat.severity).to.equal('High');
        });
    });

    describe('_mergeControlsAssessment', () => {
        it('should return empty array if both inputs are empty/null', () => {
            const result = aiController._mergeControlsAssessment(null, null);
            expect(result).to.deep.equal([]);
        });

        it('should return new assessments if prevAssessments is null', () => {
            const newAssessments = [{ securityControl: 'Access Control', userAnswer: 'Yes' }];
            const result = aiController._mergeControlsAssessment(null, newAssessments);
            expect(result).to.deep.equal(newAssessments);
        });

        it('should incrementally accumulate disjoint security controls', () => {
            const prev = [
                { securityControl: 'Segregação de Rede', userAnswer: 'Rede plana', assessment: 'Carece Melhoria', details: 'A' }
            ];
            const next = [
                { securityControl: 'Gestão de Segredos', userAnswer: 'Via env vars', assessment: 'Carece Melhoria', details: 'B' }
            ];
            const result = aiController._mergeControlsAssessment(prev, next);
            expect(result).to.have.lengthOf(2);
            expect(result[0].securityControl).to.equal('Segregação de Rede');
            expect(result[1].securityControl).to.equal('Gestão de Segredos');
        });

        it('should overwrite/update existing security control assessments matching case-insensitively', () => {
            const prev = [
                { securityControl: 'Segregação de Rede', userAnswer: 'Rede plana', assessment: 'Carece Melhoria', details: 'Old detail' }
            ];
            const next = [
                { securityControl: 'segregação de rede ', userAnswer: 'Segmentado com network policies', assessment: 'Eficaz', details: 'New detail' }
            ];
            const result = aiController._mergeControlsAssessment(prev, next);
            expect(result).to.have.lengthOf(1);
            expect(result[0].securityControl).to.equal('segregação de rede ');
            expect(result[0].userAnswer).to.equal('Segmentado com network policies');
            expect(result[0].assessment).to.equal('Eficaz');
            expect(result[0].details).to.equal('New detail');
        });
    });

    describe('_applyDeduplicationChanges', () => {
        const sampleModel = {
            detail: {
                diagrams: [{
                    diagramType: 'STRIDE',
                    cells: [
                        {
                            id: 'cell-1',
                            shape: 'store',
                            data: {
                                name: 'Azure SQL Database',
                                threats: [
                                    { id: 'threat-1', title: 'Static credentials usage', description: 'A', mitigation: 'B' },
                                    { id: 'threat-2', title: 'Static credentials without rotation', description: 'C', mitigation: 'D' }
                                ]
                            }
                        }
                    ]
                }]
            }
        };

        const sampleControls = [
            { securityControl: 'Segregação de Rede', userAnswer: 'Answer A', assessment: 'Carece Melhoria', details: 'Details A' },
            { securityControl: 'Segregação de Rede', userAnswer: 'Answer B', assessment: 'Carece Melhoria', details: 'Details B' }
        ];

        const sampleProposals = {
            controlDeduplications: [
                {
                    id: 'control-dup-1',
                    controlCategory: 'Segregação de Rede',
                    itemsToMerge: [
                        { userAnswer: 'Answer A', assessment: 'Carece Melhoria', details: 'Details A' },
                        { userAnswer: 'Answer B', assessment: 'Carece Melhoria', details: 'Details B' }
                    ],
                    proposedMergedItem: {
                        securityControl: 'Segregação de Rede',
                        userAnswer: 'Combined Answer',
                        assessment: 'Carece Melhoria',
                        details: 'Combined Details'
                    }
                }
            ],
            threatDeduplications: [
                {
                    id: 'threat-dup-1',
                    cellId: 'cell-1',
                    cellName: 'Azure SQL Database',
                    itemsToMerge: [
                        { id: 'threat-1', title: 'Static credentials usage', description: 'A', mitigation: 'B' },
                        { id: 'threat-2', title: 'Static credentials without rotation', description: 'C', mitigation: 'D' }
                    ],
                    proposedMergedThreat: {
                        title: 'Merged credentials threat',
                        description: 'Combined description',
                        mitigation: 'Combined mitigation',
                        severity: 'Critical',
                        status: 'Open',
                        type: 'Tampering',
                        modelType: 'STRIDE'
                    }
                }
            ]
        };

        it('should do nothing if proposals are null or no IDs are approved', () => {
            const { model, controlsAssessment } = aiController._applyDeduplicationChanges(sampleModel, sampleControls, null, [], []);
            expect(controlsAssessment).to.deep.equal(sampleControls);
            expect(model).to.deep.equal(sampleModel);
        });

        it('should successfully apply approved control and threat merges', () => {
            const { model, controlsAssessment } = aiController._applyDeduplicationChanges(
                sampleModel,
                sampleControls,
                sampleProposals,
                ['control-dup-1'],
                ['threat-dup-1']
            );

            // Controls check
            expect(controlsAssessment).to.have.lengthOf(1);
            expect(controlsAssessment[0].userAnswer).to.equal('Combined Answer');
            expect(controlsAssessment[0].details).to.equal('Combined Details');

            // Threats check
            const threats = model.detail.diagrams[0].cells[0].data.threats;
            expect(threats).to.have.lengthOf(1);
            expect(threats[0].title).to.equal('Merged credentials threat');
            expect(threats[0].description).to.equal('Combined description');
            expect(threats[0].mitigation).to.equal('Combined mitigation');
        });

        it('should not merge if IDs are not approved', () => {
            const { model, controlsAssessment } = aiController._applyDeduplicationChanges(
                sampleModel,
                sampleControls,
                sampleProposals,
                [],
                []
            );
            expect(controlsAssessment).to.have.lengthOf(2);
            expect(model.detail.diagrams[0].cells[0].data.threats).to.have.lengthOf(2);
        });
    });

    describe('_extractJson', () => {
        it('should parse simple valid JSON', () => {
            const json = '{"key": "value"}';
            expect(aiController._extractJson(json)).to.deep.equal({ key: "value" });
        });

        it('should strip markdown code blocks and whitespace', () => {
            const json = '```json\n{\n  "key": "value"\n}\n```';
            expect(aiController._extractJson(json)).to.deep.equal({ key: "value" });
        });

        it('should escape raw newlines and tabs inside string properties', () => {
            const json = '{\n  "key": "line1\nline2\\tline3"\n}';
            const parsed = aiController._extractJson(json);
            expect(parsed.key).to.equal("line1\nline2\tline3");
        });

        it('should escape internal unescaped double quotes in string values', () => {
            const json = '{"mitigation": "Use "Network Policies" to restrict traffic", "key": "value"}';
            const parsed = aiController._extractJson(json);
            expect(parsed.mitigation).to.equal('Use "Network Policies" to restrict traffic');
            expect(parsed.key).to.equal("value");
        });

        it('should handle single-line comments and trailing commas', () => {
            const json = '{\n  // this is a comment\n  "key": "value",\n}';
            expect(aiController._extractJson(json)).to.deep.equal({ key: "value" });
        });

        it('should repair mismatched array/object brackets and premature root closing brace', () => {
            const json = '{"threatModel":{"version":"2.0.0","summary":{"title":"Teste"},"detail":{"reviewer":"AI Threat Modeler","diagrams":[{"id":0,"cells":[]}}]}},"questions":["Por favor, valide..."]}';
            const parsed = aiController._extractJson(json);
            expect(parsed).to.have.property('threatModel');
            expect(parsed).to.have.property('questions');
            expect(parsed.threatModel.version).to.equal('2.0.0');
            expect(parsed.questions[0]).to.equal('Por favor, valide...');
        });

        it('should successfully repair truncated JSON cut off mid-string in the middle of generation', () => {
            const json = '{"threatModel":{"version":"2.0.0","summary":{"title":"Teste"},"detail":{"reviewer":"AI Threat Modeler","diagrams":[{"id":0,"cells":[{"id":"a1","shape":"actor","data":{"cell":"b20f4d68';
            const parsed = aiController._extractJson(json);
            expect(parsed).to.have.property('threatModel');
            expect(parsed.threatModel.version).to.equal('2.0.0');
            expect(parsed.threatModel.detail.diagrams[0].cells[0].data.cell).to.equal('b20f4d68');
        });

        it('should successfully repair truncated JSON cut off mid-key name at the end of generation', () => {
            const json = '{"threatModel":{"version":"2.0.0","summary":{"title":"Teste"},"detail":{"reviewer":"AI Threat Modeler","diagrams":[{"id":0,"cells":[{"id":"a1","shape":"actor","data":{"cell":"b20f4d68","hasOpenThreat';
            const parsed = aiController._extractJson(json);
            expect(parsed).to.have.property('threatModel');
            expect(parsed.threatModel.version).to.equal('2.0.0');
            expect(parsed.threatModel.detail.diagrams[0].cells[0].data.cell).to.equal('b20f4d68');
            expect(parsed.threatModel.detail.diagrams[0].cells[0].data).not.to.have.property('hasOpenThreat');
        });


        it('should heal cell references in diagram edges/flows when source/target IDs are mismatched or invalid', () => {
            const jsonObj = {
                threatModel: {
                    version: "2.0.0",
                    detail: {
                        diagrams: [
                            {
                                cells: [
                                    {
                                        id: "p44t8r02-ss19-0469-q257-p98s4oq68o01",
                                        shape: "process",
                                        attrs: { text: { text: "Azure Key Vault" } },
                                        data: { name: "Azure Key Vault" }
                                    },
                                    {
                                        id: "a10e3c57-dad4-4914-b702-a43d9bf13956",
                                        shape: "actor",
                                        attrs: { text: { text: "Aplicativos Cliente" } },
                                        data: { name: "Aplicativos Cliente" }
                                    },
                                    {
                                        id: "edge-1",
                                        shape: "flow",
                                        source: { cell: "a10e3c57-dad4-4914-b702-a43d9bf13956" },
                                        target: { cell: "proc-azure-key-vault" }
                                    },
                                    {
                                        id: "edge-2",
                                        shape: "flow",
                                        source: { cell: "nonexistent-node" },
                                        target: { cell: "a10e3c57-dad4-4914-b702-a43d9bf13956" }
                                    }
                                ]
                            }
                        ]
                    }
                }
            };
            const json = JSON.stringify(jsonObj);
            const parsed = aiController._extractJson(json);
            
            const cells = parsed.threatModel.detail.diagrams[0].cells;
            expect(cells).to.have.lengthOf(3);
            
            const edge = cells.find(c => c.id === 'edge-1');
            expect(edge).to.exist;
            expect(edge.target.cell).to.equal("p44t8r02-ss19-0469-q257-p98s4oq68o01");
            
            const discarded = cells.find(c => c.id === 'edge-2');
            expect(discarded).not.to.exist;
        });

        it('should preserve trust boundary curves and not discard them during cell healing', () => {
            const jsonObj = {
                threatModel: {
                    version: "2.0.0",
                    detail: {
                        diagrams: [
                            {
                                cells: [
                                    {
                                        id: "boundary-1",
                                        shape: "trust-boundary-curve",
                                        source: { x: 80, y: 220 },
                                        target: { x: 295, y: 51 },
                                        data: { name: "Boundary" }
                                    },
                                    {
                                        id: "node-1",
                                        shape: "process",
                                        data: { name: "Some Process" }
                                    }
                                ]
                            }
                        ]
                    }
                }
            };
            const json = JSON.stringify(jsonObj);
            const parsed = aiController._extractJson(json);
            
            const cells = parsed.threatModel.detail.diagrams[0].cells;
            expect(cells).to.have.lengthOf(2);
            
            const boundary = cells.find(c => c.id === 'boundary-1');
            expect(boundary).to.exist;
            expect(boundary.source.x).to.equal(80);
            expect(boundary.target.x).to.equal(295);
        });

        it('should fix bracket transpositions where LLM produces }}]} instead of }}}] in labels', () => {
            const jsonStr = '```json\n' + JSON.stringify({
                threatModel: {
                    version: "2.0.0",
                    detail: {
                        diagrams: [{
                            cells: [
                                {
                                    id: "node-1",
                                    shape: "process",
                                    data: { name: "Service A" }
                                },
                                {
                                    id: "node-2",
                                    shape: "process",
                                    data: { name: "Service B" }
                                }
                            ]
                        }]
                    }
                }
            }).replace(
                // Simulate the LLM's bracket error in the raw string
                '"cells":[',
                '"cells":['
            ) + '\n```';

            // Now create a version with the broken labels pattern injected
            const brokenJson = `\`\`\`json
{
  "threatModel": {
    "version": "2.0.0",
    "detail": {
      "diagrams": [{
        "cells": [
          {"id": "n1", "shape": "process", "data": {"name": "Svc A"}},
          {"id": "n2", "shape": "process", "data": {"name": "Svc B"}},
          {
            "id": "f1", "shape": "flow",
            "source": {"cell": "n1"}, "target": {"cell": "n2"},
            "labels": [{"attrs": {"labelText": {"text": "Metrics"}}]},
            "data": {"type": "tm.Flow"}
          }
        ]
      }]
    }
  }
}
\`\`\``;
            const parsed = aiController._extractJson(brokenJson);
            expect(parsed).to.have.property('threatModel');
            const cells = parsed.threatModel.detail.diagrams[0].cells;
            const flow = cells.find(c => c.id === 'f1');
            expect(flow).to.exist;
            expect(flow.data.type).to.equal('tm.Flow');
        });
    });

    describe('_callAIModel', () => {
        let getClientStub;
        let createStub;

        beforeEach(() => {
            createStub = sinon.stub();
            const mockOpenAI = {
                chat: {
                    completions: {
                        create: createStub
                    }
                }
            };
            getClientStub = sinon.stub(aiController._clientFactory, 'getOpenAIClient').returns(mockOpenAI);
        });

        afterEach(() => {
            getClientStub.restore();
        });

        it('should call Bedrock Mantle without thinking block if extendedThinking is false/undefined', async () => {
            createStub.resolves({ choices: [{ message: { content: 'Threat response' } }] });
            
            const aiConfig = {
                provider: 'bedrock-mantle',
                apiKey: 'test-key',
                baseUrl: 'http://localhost:3000',
                model: 'meta.llama3'
            };

            const response = await aiController._callAIModel('Hello', [], aiConfig);
            expect(response).to.equal('Threat response');
            
            expect(getClientStub).to.have.been.calledOnceWith(aiConfig);
            expect(createStub).to.have.been.calledOnce;
            const callArgs = createStub.firstCall.args;
            expect(callArgs[0].thinking).to.be.undefined;
            expect(callArgs[0].reasoning_effort).to.be.undefined;
        });

        it('should inject thinking and reasoning_effort blocks into Bedrock Mantle payload if extendedThinking is true', async () => {
            createStub.resolves({ choices: [{ message: { content: 'Threat response' } }] });
            
            const aiConfig = {
                provider: 'bedrock-mantle',
                apiKey: 'test-key',
                baseUrl: 'http://localhost:3000',
                model: 'meta.llama3',
                extendedThinking: true
            };

            const response = await aiController._callAIModel('Hello', [], aiConfig);
            expect(response).to.equal('Threat response');
            
            expect(getClientStub).to.have.been.calledOnceWith(aiConfig);
            expect(createStub).to.have.been.calledOnce;
            const callArgs = createStub.firstCall.args;
            expect(callArgs[0].thinking).to.deep.equal({
                type: 'enabled',
                budget_tokens: 2048
            });
            expect(callArgs[0].reasoning_effort).to.equal('medium');
        });

        it('should recover response from Bedrock Mantle on timeout if prompt matches', async () => {
            const timeoutError = new Error('Request timed out');
            timeoutError.name = 'APITimeoutError';
            createStub.rejects(timeoutError);
            
            const getStub = sinon.stub(axios, 'get').resolves({
                data: {
                    data: [
                        {
                            id: 'resp-123',
                            status: 'completed',
                            input: {
                                messages: [{ role: 'user', content: 'Hello' }]
                            },
                            output: {
                                choices: [{ message: { content: 'Recovered threat response' } }]
                            }
                        }
                    ]
                }
            });

            const aiConfig = {
                provider: 'bedrock-mantle',
                apiKey: 'test-key',
                baseUrl: 'http://localhost:3000',
                model: 'meta.llama3'
            };

            const response = await aiController._callAIModel('Hello', [], aiConfig);
            expect(response).to.equal('Recovered threat response');
            
            expect(getClientStub).to.have.been.calledOnceWith(aiConfig);
            expect(createStub).to.have.been.calledOnce;
            expect(getStub).to.have.been.calledOnce;
            
            const getCallArgs = getStub.firstCall.args;
            expect(getCallArgs[0]).to.equal('http://localhost:3000/responses');
            expect(getCallArgs[1].headers.Authorization).to.equal('Bearer test-key');
            expect(getCallArgs[1].params.limit).to.equal(5);

            getStub.restore();
        });

        it('should poll for completion if recovered response is in_progress', async () => {
            const clock = sinon.useFakeTimers();
            const timeoutError = new Error('Request timed out');
            timeoutError.name = 'APITimeoutError';
            createStub.rejects(timeoutError);
            
            const getStub = sinon.stub(axios, 'get');
            // First call (listing) returns in_progress
            getStub.onFirstCall().resolves({
                data: {
                    data: [
                        {
                            id: 'resp-456',
                            status: 'in_progress',
                            input: {
                                messages: [{ role: 'user', content: 'Hello' }]
                            }
                        }
                    ]
                }
            });
            // Second call (polling retrieve) returns completed
            getStub.onSecondCall().resolves({
                data: {
                    id: 'resp-456',
                    status: 'completed',
                    output: {
                        choices: [{ message: { content: 'Polled threat response' } }]
                    }
                }
            });

            const aiConfig = {
                provider: 'bedrock-mantle',
                apiKey: 'test-key',
                baseUrl: 'http://localhost:3000',
                model: 'meta.llama3'
            };

            const promise = aiController._callAIModel('Hello', [], aiConfig);
            
            // Advance the fake timers so the setTimeout completes
            await clock.tickAsync(5000);
            
            const response = await promise;
            expect(response).to.equal('Polled threat response');
            
            expect(getClientStub).to.have.been.calledOnceWith(aiConfig);
            expect(createStub).to.have.been.calledOnce;
            expect(getStub).to.have.been.calledTwice;
            
            expect(getStub.firstCall.args[0]).to.equal('http://localhost:3000/responses');
            expect(getStub.secondCall.args[0]).to.equal('http://localhost:3000/responses/resp-456');

            getStub.restore();
            clock.restore();
        });
    });

    describe('_getMaxContextChars', () => {
        it('should return 600000 for Gemini provider', () => {
            const config = { provider: 'gemini', model: 'gemini-1.5-pro' };
            expect(aiController._getMaxContextChars(config)).to.equal(600000);
        });

        it('should return 250000 for Bedrock Mantle with Llama 3.1 model', () => {
            const config = { provider: 'bedrock-mantle', model: 'meta.llama3.1-70b-instruct' };
            expect(aiController._getMaxContextChars(config)).to.equal(250000);
        });

        it('should return 400000 for Bedrock Mantle with Claude 3 model', () => {
            const config = { provider: 'bedrock-mantle', model: 'anthropic.claude-3-sonnet' };
            expect(aiController._getMaxContextChars(config)).to.equal(400000);
        });

        it('should return 15000 for Bedrock Mantle with Llama 3 original model', () => {
            const config = { provider: 'bedrock-mantle', model: 'meta.llama3-8b' };
            expect(aiController._getMaxContextChars(config)).to.equal(15000);
        });

        it('should return 100000 for Bedrock Mantle default/other models', () => {
            const config = { provider: 'bedrock-mantle', model: 'unknown-model' };
            expect(aiController._getMaxContextChars(config)).to.equal(100000);
        });

        it('should fallback to 15000 for other/unknown config', () => {
            expect(aiController._getMaxContextChars({})).to.equal(15000);
        });

        it('should calculate char limit from custom maxContextTokens (simplificado/k)', () => {
            const config = { maxContextTokens: 128 };
            expect(aiController._getMaxContextChars(config)).to.equal(128 * 1000 * 3);
            const config2 = { maxContextTokens: 256 };
            expect(aiController._getMaxContextChars(config2)).to.equal(256 * 1000 * 3);
        });

        it('should calculate char limit from custom maxContextTokens (completo)', () => {
            const config = { maxContextTokens: 128000 };
            expect(aiController._getMaxContextChars(config)).to.equal(128000 * 3);
        });
    });

    describe('_getQuestionBatchSize', () => {
        it('should respect custom questionBatchSize if provided and valid', () => {
            const config = { questionBatchSize: 6 };
            expect(aiController._getQuestionBatchSize(config)).to.equal(6);
        });

        it('should cap custom questionBatchSize at 15', () => {
            const config = { questionBatchSize: 20 };
            expect(aiController._getQuestionBatchSize(config)).to.equal(15);
        });

        it('should return 8 for high context limit (>= 600k chars)', () => {
            const config = { provider: 'gemini', model: 'gemini-1.5-pro' };
            expect(aiController._getQuestionBatchSize(config)).to.equal(8);
        });

        it('should return 5 for medium context limit (>= 250k chars)', () => {
            const config = { provider: 'bedrock-mantle', model: 'meta.llama3.1-70b-instruct' };
            expect(aiController._getQuestionBatchSize(config)).to.equal(5);
        });

        it('should return 4 for moderate context limit (>= 100k chars)', () => {
            const config = { provider: 'bedrock-mantle', model: 'unknown-model' };
            expect(aiController._getQuestionBatchSize(config)).to.equal(4);
        });

        it('should fallback to 3 for small context limit (< 100k chars)', () => {
            const config = { provider: 'bedrock-mantle', model: 'meta.llama3-8b' };
            expect(aiController._getQuestionBatchSize(config)).to.equal(3);
        });
    });

    describe('editAnswers', () => {
        let getSessionStub, updateSessionStub;

        beforeEach(() => {
            getSessionStub = sinon.stub(aiContextStore, 'getSession');
            updateSessionStub = sinon.stub(aiContextStore, 'updateSession');
        });

        afterEach(() => {
            getSessionStub.restore();
            updateSessionStub.restore();
        });

        it('should return 404 if session is not found', async () => {
            getSessionStub.returns(null);
            const req = { params: { sessionId: 'nonexistent' }, body: { answeredQuestions: [] } };
            const res = {
                status: sinon.stub().returnsThis(),
                json: sinon.stub()
            };

            await aiController.editAnswers(req, res);
            expect(res.status).to.have.been.calledWith(404);
        });

        it('should return 400 if answeredQuestions is missing or not an array', async () => {
            getSessionStub.returns({});
            const req = { params: { sessionId: 'session-1' }, body: {} };
            const res = {
                status: sinon.stub().returnsThis(),
                json: sinon.stub()
            };

            await aiController.editAnswers(req, res);
            expect(res.status).to.have.been.calledWith(400);
        });
    });

    describe('exportQuestions', () => {
        let getSessionStub;

        beforeEach(() => {
            getSessionStub = sinon.stub(aiContextStore, 'getSession');
        });

        afterEach(() => {
            getSessionStub.restore();
        });

        it('should return 404 if session is not found', async () => {
            getSessionStub.returns(null);
            const req = { params: { sessionId: 'nonexistent' } };
            const res = {
                status: sinon.stub().returnsThis(),
                json: sinon.stub()
            };

            await aiController.exportQuestions(req, res);
            expect(res.status).to.have.been.calledWith(404);
        });

        it('should return 400 if questionPlan is not computed', async () => {
            getSessionStub.returns({ title: 'Test' });
            const req = { params: { sessionId: 'session-1' } };
            const res = {
                status: sinon.stub().returnsThis(),
                json: sinon.stub()
            };

            await aiController.exportQuestions(req, res);
            expect(res.status).to.have.been.calledWith(400);
        });
    });

    describe('importAnswers', () => {
        let getSessionStub, updateSessionStub;

        beforeEach(() => {
            getSessionStub = sinon.stub(aiContextStore, 'getSession');
            updateSessionStub = sinon.stub(aiContextStore, 'updateSession');
        });

        afterEach(() => {
            getSessionStub.restore();
            updateSessionStub.restore();
        });

        it('should return 404 if session is not found', async () => {
            getSessionStub.returns(null);
            const req = { params: { sessionId: 'nonexistent' }, body: { answers: [] } };
            const res = {
                status: sinon.stub().returnsThis(),
                json: sinon.stub()
            };

            await aiController.importAnswers(req, res);
            expect(res.status).to.have.been.calledWith(404);
        });

        it('should return 400 if answers array is missing or empty', async () => {
            getSessionStub.returns({});
            const req = { params: { sessionId: 'session-1' }, body: {} };
            const res = {
                status: sinon.stub().returnsThis(),
                json: sinon.stub()
            };

            await aiController.importAnswers(req, res);
            expect(res.status).to.have.been.calledWith(400);
        });
    });

    describe('applyRequirements', () => {
        let getSessionStub;

        beforeEach(() => {
            getSessionStub = sinon.stub(aiContextStore, 'getSession');
        });

        afterEach(() => {
            getSessionStub.restore();
        });

        it('should return 404 if session is not found', async () => {
            getSessionStub.returns(null);
            const req = { params: { sessionId: 'nonexistent' }, body: { requirements: [] } };
            const res = {
                status: sinon.stub().returnsThis(),
                json: sinon.stub()
            };

            await aiController.applyRequirements(req, res);
            expect(res.status).to.have.been.calledWith(404);
        });

        it('should return 400 if requirements array is missing or empty', async () => {
            getSessionStub.returns({});
            const req = { params: { sessionId: 'session-1' }, body: {} };
            const res = {
                status: sinon.stub().returnsThis(),
                json: sinon.stub()
            };

            await aiController.applyRequirements(req, res);
            expect(res.status).to.have.been.calledWith(400);
        });
    });
});
