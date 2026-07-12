import { expect } from 'chai';
import { compressModelForPrompt, managePromptContext } from '../../src/helpers/ai/utils.js';

describe('helpers/ai/utils.js', () => {
    describe('compressModelForPrompt', () => {
        it('should strip threat descriptions and mitigations of mitigated threats to reduce token size', () => {
            const originalModel = {
                detail: {
                    diagrams: [{
                        cells: [
                            {
                                id: 'cell-1',
                                shape: 'process',
                                data: {
                                    name: 'API Service',
                                    threats: [
                                        {
                                            id: 'threat-1',
                                            title: 'Spoofing threat',
                                            status: 'Mitigated',
                                            description: 'Detailed description of spoofing threat which is very long',
                                            mitigation: 'Implement strong auth and validation mechanisms'
                                        }
                                    ]
                                }
                            }
                        ]
                    }]
                }
            };

            const compressed = compressModelForPrompt(originalModel);
            const cell = compressed.detail.diagrams[0].cells[0];
            expect(cell.data.name).to.equal('API Service');
            expect(cell.data.threats[0].id).to.equal('threat-1');
            expect(cell.data.threats[0].title).to.equal('Spoofing threat');
            expect(cell.data.threats[0].status).to.equal('Mitigated');
            expect(cell.data.threats[0].description).to.equal('');
            expect(cell.data.threats[0].mitigation).to.equal('');
        });

        it('should NOT strip threat descriptions and mitigations of open threats', () => {
            const originalModel = {
                detail: {
                    diagrams: [{
                        cells: [
                            {
                                id: 'cell-1',
                                shape: 'process',
                                data: {
                                    name: 'API Service',
                                    threats: [
                                        {
                                            id: 'threat-1',
                                            title: 'Spoofing threat',
                                            status: 'Open',
                                            description: 'Detailed description',
                                            mitigation: 'Implement auth'
                                        }
                                    ]
                                }
                            }
                        ]
                    }]
                }
            };

            const compressed = compressModelForPrompt(originalModel);
            const cell = compressed.detail.diagrams[0].cells[0];
            expect(cell.data.threats[0].description).to.equal('Detailed description');
            expect(cell.data.threats[0].mitigation).to.equal('Implement auth');
        });

        it('should handle missing cell data gracefully', () => {
            const model = {
                detail: {
                    diagrams: [{
                        cells: [
                            { id: 'cell-2', shape: 'flow' }
                        ]
                    }]
                }
            };
            const compressed = compressModelForPrompt(model);
            expect(compressed.detail.diagrams[0].cells[0].id).to.equal('cell-2');
        });
    });

    describe('managePromptContext', () => {
        it('should return context unmodified if total length is below max limit', () => {
            const docsContext = 'Some short docs';
            const refinementHistory = [{ role: 'user', text: 'Hi' }];
            const currentModel = { detail: { diagrams: [] } };
            const maxLimit = 20000;

            const result = managePromptContext(docsContext, refinementHistory, currentModel, maxLimit);
            expect(result.docsContext).to.equal(docsContext);
            expect(result.refinementHistory).to.deep.equal(refinementHistory);
        });

        it('should truncate refinementHistory first if total length exceeds limit', () => {
            const docsContext = 'Doc text';
            const refinementHistory = [
                { role: 'user', text: 'V1' },
                { role: 'model', text: 'V2' },
                { role: 'user', text: 'V3' },
                { role: 'model', text: 'V4' },
                { role: 'user', text: 'V5' }
            ];
            const currentModel = { detail: { diagrams: [] } };
            // Set limit to trigger truncation of history (but not docs)
            const maxLimit = 15100;

            const result = managePromptContext(docsContext, refinementHistory, currentModel, maxLimit);
            expect(result.refinementHistory.length).to.be.lessThan(refinementHistory.length);
            // Ensure at least the last message is preserved
            expect(result.refinementHistory[result.refinementHistory.length - 1].text).to.equal('V5');
        });

        it('should truncate docsContext if even after history truncation we exceed limit', () => {
            const docsContext = 'This is an extremely long documentation context that needs to be truncated';
            const refinementHistory = [];
            const currentModel = { detail: { diagrams: [] } };
            const maxLimit = 15020;

            const result = managePromptContext(docsContext, refinementHistory, currentModel, maxLimit);
            expect(result.docsContext).to.include('omitido por limite de contexto');
            expect(result.docsContext.length).to.be.lessThan(docsContext.length);
        });
    });
});
