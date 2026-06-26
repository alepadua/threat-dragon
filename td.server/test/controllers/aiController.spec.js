import { expect } from 'chai';
import aiController from '../../src/controllers/aiController.js';

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
});
