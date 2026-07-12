import { expect } from 'chai';
import promptBuilder from '../../src/helpers/ai/promptBuilder.js';

describe('helpers/ai/promptBuilder.js', () => {
    describe('buildGeneratorPrompt', () => {
        it('should inject structured answered questions section if they exist in the session', () => {
            const activeSession = {
                refinementHistory: [],
                answeredQuestions: [
                    {
                        elementName: 'Auth Service',
                        category: 'Authentication',
                        text: 'How is authentication implemented?',
                        answer: 'Using oauth2 authorization code flow with Keycloak.'
                    }
                ]
            };

            const prompt = promptBuilder.buildGeneratorPrompt({
                dfdApprovedBool: true,
                title: 'Test App',
                description: 'A test application',
                activeSession,
                methodology: 'STRIDE',
                modelSpecJson: '{}',
                evalObj: null
            });

            expect(prompt).to.include('--- USER-PROVIDED ANSWERS AND COMPONENT SPECIFICATIONS ---');
            expect(prompt).to.include('Element/Flow: "Auth Service" | Category: "Authentication"');
            expect(prompt).to.include('- Question: How is authentication implemented?');
            expect(prompt).to.include('- User Answer: Using oauth2 authorization code flow with Keycloak.');
        });
    });

    describe('buildDedupAuditPrompt', () => {
        it('should include historyContext', () => {
            const prompt = promptBuilder.buildDedupAuditPrompt({}, [], 'docs text', 'history content text');
            expect(prompt).to.include('history content text');
        });
    });

    describe('buildMitigationRevisionPrompt', () => {
        it('should include historyContext', () => {
            const prompt = promptBuilder.buildMitigationRevisionPrompt({}, 'docs text', 'history content text');
            expect(prompt).to.include('history content text');
        });
    });
});
