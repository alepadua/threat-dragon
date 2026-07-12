import { expect } from 'chai';
import questionPlanningEngine from '../../src/helpers/questionPlanningEngine.js';

describe('helpers/questionPlanningEngine.js', () => {
    describe('computeQuestionPlan', () => {
        it('should consolidate threat and mitigation into a single consolidated question per category', () => {
            const cells = [
                {
                    id: 'cell-1',
                    shape: 'process',
                    data: { name: 'My Process Service' }
                }
            ];

            const plan = questionPlanningEngine.computeQuestionPlan(cells, 'STRIDE');

            expect(plan.methodology).to.equal('STRIDE');
            // STRIDE process elements map to 6 categories: Spoofing, Tampering, Repudiation, Info Disclosure, Denial of Service, Elevation of Privilege.
            // With 1 consolidated question per category, we expect exactly 6 element questions.
            expect(plan.breakdown.elementQuestions).to.equal(6);
            expect(plan.plannedQuestions).to.be.an('array').with.lengthOf(6);

            const elementQ = plan.elementQuestions[0];
            expect(elementQ.elementId).to.equal('cell-1');
            expect(elementQ.elementName).to.equal('My Process Service');

            // Check that all questions in categories have type 'consolidated'
            elementQ.categories.forEach((catGroup) => {
                expect(catGroup.questions).to.have.lengthOf(1);
                expect(catGroup.questions[0].type).to.equal('consolidated');
            });
        });

        it('should group similar flows by their source and target shape types into a single virtual flow cell', () => {
            const cells = [
                {
                    id: 'actor-1',
                    shape: 'actor',
                    data: { name: 'User Client' }
                },
                {
                    id: 'process-1',
                    shape: 'process',
                    data: { name: 'API Gateway' }
                },
                {
                    id: 'store-1',
                    shape: 'store',
                    data: { name: 'Main DB' }
                },
                // Flow 1: actor to process
                {
                    id: 'flow-1',
                    shape: 'flow',
                    source: { cell: 'actor-1' },
                    target: { cell: 'process-1' },
                    data: { name: 'Client Request' }
                },
                // Flow 2: process to store
                {
                    id: 'flow-2',
                    shape: 'flow',
                    source: { cell: 'process-1' },
                    target: { cell: 'store-1' },
                    data: { name: 'DB Write' }
                },
                // Flow 3: process to store (similar to Flow 2)
                {
                    id: 'flow-3',
                    shape: 'flow',
                    source: { cell: 'process-1' },
                    target: { cell: 'store-1' },
                    data: { name: 'DB Read' }
                }
            ];

            const plan = questionPlanningEngine.computeQuestionPlan(cells, 'STRIDE');

            // Elements in plan should be:
            // 1. actor-1 (actor) -> 2 categories (Spoofing, Repudiation) -> 2 questions
            // 2. process-1 (process) -> 6 categories (STRIDE) -> 6 questions
            // 3. store-1 (store) -> 3 categories (Tampering, Info Disclosure, DoS) -> 3 questions
            // 4. Grouped flow actor_to_process -> 3 categories -> 3 questions
            // 5. Grouped flow process_to_store -> 3 categories -> 3 questions
            // Total element questions: 2 + 6 + 3 + 3 + 3 = 17 questions.
            expect(plan.breakdown.elementQuestions).to.equal(17);
            expect(plan.plannedQuestions).to.be.an('array').with.lengthOf(17);

            // We expect exactly 5 element question entries in the plan
            expect(plan.elementQuestions).to.have.lengthOf(5);

            // Verify virtual flow cell for process-to-store exists
            const procToStoreFlow = plan.elementQuestions.find(e => e.elementId === 'flow-group-process_to_store');
            expect(procToStoreFlow).to.not.be.undefined;
            expect(procToStoreFlow.elementName).to.include('Fluxos: Processo para Data Store');
            expect(procToStoreFlow.elementName).to.include('DB Write');
            expect(procToStoreFlow.elementName).to.include('DB Read');

            // Verify virtual flow cell for actor-to-process exists
            const actorToProcFlow = plan.elementQuestions.find(e => e.elementId === 'flow-group-actor_to_process');
            expect(actorToProcFlow).to.not.be.undefined;
            expect(actorToProcFlow.elementName).to.include('Fluxos: Entidade Externa para Processo');
            expect(actorToProcFlow.elementName).to.include('Client Request');
        });
    });
});
