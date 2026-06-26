<template>
    <b-row class="justify-content-center">
        <b-col md="11" lg="10">
            <!-- Input Form Card -->
            <b-card
                v-if="step === 'input'"
                class="ai-modeler-card shadow-lg border-0 mb-4"
                header-class="bg-dark text-white border-0 py-3"
            >
                <template #header>
                    <div class="d-flex align-items-center">
                        <font-awesome-icon icon="robot" class="mr-3 text-warning" size="lg" />
                        <h4 class="mb-0 font-weight-bold">{{ $t('aiThreatModeler.title') }}</h4>
                    </div>
                </template>

                <p class="text-muted mb-4">{{ $t('aiThreatModeler.description') }}</p>

                <!-- Session Recovery Banner -->
                <div v-if="savedSessionId" class="alert alert-info d-flex justify-content-between align-items-center mb-4 shadow-sm py-2 px-3">
                    <div class="d-flex align-items-center font-size-sm">
                        <font-awesome-icon icon="undo" class="mr-2 text-info" />
                        <span><strong>Unfinished AI Threat Model detected.</strong> You can resume your last session.</span>
                    </div>
                    <div>
                        <b-button size="sm" variant="info" class="mr-2 font-weight-bold" @click="resumeSession(savedSessionId)">
                            Resume Session
                        </b-button>
                        <b-button size="sm" variant="outline-secondary" class="font-weight-bold" @click="clearSavedSession">
                            Dismiss
                        </b-button>
                    </div>
                </div>

                <b-form @submit.prevent="generateModel">
                    <!-- Title & Description -->
                    <b-form-row>
                        <b-col md="6">
                            <b-form-group
                                id="title-group"
                                :label="$t('aiThreatModeler.formTitle')"
                                label-for="title"
                                label-class="font-weight-bold"
                            >
                                <b-form-input
                                    id="title"
                                    v-model="form.title"
                                    type="text"
                                    placeholder="e.g. My Secure Web Application"
                                    required
                                    class="custom-input"
                                ></b-form-input>
                            </b-form-group>
                        </b-col>
                        <b-col md="6">
                            <b-form-group
                                id="api-key-group"
                                :label="$t('aiThreatModeler.apiKeyOverride')"
                                label-for="apiKey"
                                label-class="font-weight-bold"
                            >
                                <b-form-input
                                    id="apiKey"
                                    v-model="form.apiKey"
                                    type="password"
                                    :placeholder="$t('aiThreatModeler.apiKeyPlaceholder')"
                                    class="custom-input"
                                ></b-form-input>
                            </b-form-group>
                        </b-col>
                    </b-form-row>

                    <b-form-row>
                        <b-col md="12">
                            <b-form-group
                                id="methodology-group"
                                label="Methodology Focus"
                                label-for="methodology"
                                label-class="font-weight-bold"
                            >
                                <td-form-select
                                    id="methodology"
                                    v-model="form.methodology"
                                    :options="[
                                        { value: 'STRIDE', text: 'STRIDE (Standard Cyber Security)' },
                                        { value: 'MITRE_F3', text: 'MITRE F3 (Fraud Prevention Framework)' }
                                    ]"
                                />
                            </b-form-group>
                        </b-col>
                    </b-form-row>

                    <b-form-group
                        id="description-group"
                        :label="$t('aiThreatModeler.formDescription')"
                        label-for="description"
                        label-class="font-weight-bold"
                    >
                        <b-form-textarea
                            id="description"
                            v-model="form.description"
                            rows="2"
                            placeholder="Briefly describe the system modules, users, data flows..."
                            class="custom-input"
                        ></b-form-textarea>
                    </b-form-group>

                    <!-- Documentation files dropzone (supports txt, md, docx, pdf) -->
                    <b-form-group :label="$t('aiThreatModeler.formDocs')" label-class="font-weight-bold">
                        <div
                            class="dropzone py-4 text-center border-dashed rounded mb-2"
                            @dragover.prevent
                            @drop.prevent="onDocDrop"
                            @click="triggerFileInput('docFile')"
                        >
                            <font-awesome-icon icon="file-alt" class="text-secondary mb-2" size="2x" />
                            <p class="mb-0 text-muted font-size-sm">{{ $t('aiThreatModeler.dropFiles') }}</p>
                            <input
                                id="docFile"
                                type="file"
                                multiple
                                accept=".txt,.md,.docx,.pdf"
                                class="d-none"
                                @change="onDocSelect"
                            />
                        </div>
                        <!-- Doc Files List -->
                        <div v-if="docs.length > 0" class="file-list p-2 bg-light border rounded">
                            <div
                                v-for="(file, idx) in docs"
                                :key="idx"
                                class="d-flex justify-content-between align-items-center mb-1 font-size-sm py-1 border-bottom"
                            >
                                <span><font-awesome-icon icon="check" class="text-success mr-2" />{{ file.name }}</span>
                                <b-button size="sm" variant="link" class="text-danger p-0" @click="removeDoc(idx)">
                                    <font-awesome-icon icon="trash" />
                                </b-button>
                            </div>
                        </div>
                    </b-form-group>

                    <!-- Image files dropzone -->
                    <b-form-group :label="$t('aiThreatModeler.formImages')" label-class="font-weight-bold">
                        <div
                            class="dropzone py-4 text-center border-dashed rounded mb-2"
                            @dragover.prevent
                            @drop.prevent="onImageDrop"
                            @click="triggerFileInput('imgFile')"
                        >
                            <font-awesome-icon icon="project-diagram" class="text-secondary mb-2" size="2x" />
                            <p class="mb-0 text-muted font-size-sm">{{ $t('aiThreatModeler.dropFiles') }}</p>
                            <input
                                id="imgFile"
                                type="file"
                                multiple
                                accept="image/*"
                                class="d-none"
                                @change="onImageSelect"
                            />
                        </div>
                        <!-- Images list -->
                        <div v-if="images.length > 0" class="file-list p-2 bg-light border rounded">
                            <div
                                v-for="(file, idx) in images"
                                :key="idx"
                                class="d-flex justify-content-between align-items-center mb-1 font-size-sm py-1 border-bottom"
                            >
                                <span><font-awesome-icon icon="check" class="text-success mr-2" />{{ file.name }}</span>
                                <b-button size="sm" variant="link" class="text-danger p-0" @click="removeImage(idx)">
                                    <font-awesome-icon icon="trash" />
                                </b-button>
                            </div>
                        </div>
                    </b-form-group>

                    <!-- Generate Button -->
                    <div class="text-right mt-4">
                        <b-button
                            type="submit"
                            variant="warning"
                            class="px-4 py-2 font-weight-bold text-dark shadow-sm generate-btn"
                        >
                            <font-awesome-icon icon="robot" class="mr-2" />
                            {{ $t('aiThreatModeler.generateBtn') }}
                        </b-button>
                    </div>
                </b-form>
            </b-card>

            <!-- Recent Sessions History -->
            <b-card
                v-if="step === 'input' && recentSessions.length > 0"
                class="ai-modeler-card shadow-sm border-0 mb-4"
                header-class="bg-dark text-white border-0 py-2"
            >
                <template #header>
                    <div class="d-flex align-items-center">
                        <font-awesome-icon icon="folder-open" class="mr-2 text-warning" />
                        <h5 class="mb-0 font-weight-bold">Recent AI Threat Modeling Sessions</h5>
                    </div>
                </template>
                
                <b-table-simple hover small responsive class="mb-0">
                    <b-thead>
                        <b-tr>
                            <b-th>Title</b-th>
                            <b-th>Methodology</b-th>
                            <b-th>Last Saved</b-th>
                            <b-th class="text-right">Actions</b-th>
                        </b-tr>
                    </b-thead>
                    <b-tbody>
                        <b-tr v-for="session in recentSessions" :key="session.sessionId">
                            <b-td class="align-middle font-weight-bold text-dark">{{ session.title }}</b-td>
                            <b-td class="align-middle">
                                <b-badge :variant="session.methodology === 'STRIDE' ? 'primary' : 'warning'">
                                    {{ session.methodology }}
                                </b-badge>
                            </b-td>
                            <b-td class="align-middle text-muted font-size-sm">
                                {{ new Date(session.timestamp).toLocaleString() }}
                            </b-td>
                            <b-td class="text-right align-middle">
                                <b-button size="sm" variant="success" class="mr-2 font-weight-bold" @click="resumeSession(session.sessionId)">
                                    Resume
                                </b-button>
                                <b-button size="sm" variant="outline-danger" class="font-weight-bold" @click="deleteSessionFromHistory(session.sessionId)">
                                    <font-awesome-icon icon="trash" />
                                </b-button>
                            </b-td>
                        </b-tr>
                    </b-tbody>
                </b-table-simple>
            </b-card>

            <!-- Loading / Progress View -->
            <b-card v-else-if="step === 'generating'" class="shadow-lg border-0 mb-4 py-4 text-center">
                <div class="loading-container mb-4">
                    <b-spinner variant="warning" label="Spinning" class="mb-3" style="width: 3rem; height: 3rem;"></b-spinner>
                    <h4 class="font-weight-bold">{{ $t('aiThreatModeler.generating') }}</h4>
                </div>

                <div class="progress-steps text-left mx-auto col-md-8 px-0 mt-4">
                    <div
                        v-for="(progressStep, idx) in progressSteps"
                        :key="idx"
                        class="d-flex align-items-center py-2 border-bottom"
                        :class="getProgressStepClass(idx)"
                    >
                        <font-awesome-icon
                            :icon="getProgressStepIcon(idx)"
                            class="mr-3"
                            :class="getProgressStepIconClass(idx)"
                        />
                        <span class="font-weight-medium">{{ progressStep.label }}</span>
                    </div>
                </div>
            </b-card>

            <!-- DFD Validation / Human-in-the-Loop View -->
            <b-row v-else-if="step === 'validate-dfd'" class="mb-4">
                <!-- Left: Model Preview Stats & DFD Critique -->
                <b-col md="5" class="mb-3">
                    <b-card class="shadow-sm border-0 h-100" header-class="bg-dark text-white py-2">
                        <template #header>
                            <div class="d-flex justify-content-between align-items-center">
                                <h5 class="mb-0 font-weight-bold">Diagram Draft Preview</h5>
                                <b-badge variant="info" class="px-2 py-1">Evolução Rodada {{ refinementRound }}</b-badge>
                            </div>
                        </template>

                        <!-- Stats summary -->
                        <b-row class="text-center mb-3">
                            <b-col cols="6" class="px-1">
                                <div class="py-2 bg-light border rounded">
                                    <h4 class="font-weight-bold text-primary mb-0">{{ stats.elements }}</h4>
                                    <small class="text-muted font-size-xs">Components</small>
                                </div>
                            </b-col>
                            <b-col cols="6" class="px-1">
                                <div class="py-2 bg-light border rounded">
                                    <h4 class="font-weight-bold text-success mb-0">{{ stats.flows }}</h4>
                                    <small class="text-muted font-size-xs">Data Flows</small>
                                </div>
                            </b-col>
                        </b-row>

                        <!-- Completeness Score Card -->
                        <div class="completeness-score-box bg-light border rounded p-3 mb-3 text-center">
                            <h6 class="font-weight-bold text-muted mb-1">DFD Completeness Score</h6>
                            <div class="d-flex align-items-center justify-content-center mb-2">
                                <h2 class="font-weight-bold mb-0 text-warning" style="font-size: 2.2rem;">
                                    <span v-if="previousScore !== null && previousScore !== (evaluation ? evaluation.completenessScore : 0)" class="text-muted mr-2" style="font-size: 1.2rem; text-decoration: line-through;">
                                        {{ previousScore }}%
                                    </span>
                                    {{ evaluation ? evaluation.completenessScore : 0 }}%
                                    <span v-if="previousScore !== null && (evaluation ? evaluation.completenessScore : 0) > previousScore" class="text-success ml-2" style="font-size: 1.2rem;">
                                        &nbsp;📈 +{{ (evaluation ? evaluation.completenessScore : 0) - previousScore }}%
                                    </span>
                                </h2>
                            </div>
                            <div v-if="evaluation" class="font-size-xs text-left text-muted mt-2 border-top pt-2">
                                <div class="d-flex justify-content-between mb-1">
                                    <span>Component Coverage:</span>
                                    <span class="font-weight-bold">{{ evaluation.criteria.elementCoverage }}%</span>
                                </div>
                                <div class="d-flex justify-content-between">
                                    <span>Unresolved Elements:</span>
                                    <span class="font-weight-bold text-danger">{{ evaluation.criteria.unresolvedQuestionsCount }}</span>
                                </div>
                            </div>
                            <!-- Status badge -->
                            <div class="mt-2">
                                <span class="badge py-1 px-3 font-weight-bold badge-warning text-dark">
                                    Status: Awaiting Human Validation
                                </span>
                            </div>
                            <!-- Critique feedback text -->
                            <div v-if="evaluation && evaluation.feedback" class="mt-3 text-left border-top pt-2 font-size-xs">
                                <div class="font-weight-bold text-dark mb-1">
                                    <font-awesome-icon icon="info-circle" class="mr-1 text-info" />
                                    Crítica do DFD (DFDCriticAgent):
                                </div>
                                <div class="text-muted" style="line-height: 1.35; white-space: pre-wrap;">{{ evaluation.feedback }}</div>
                            </div>
                        </div>

                        <!-- Action buttons directly below stats -->
                        <div class="mt-3 pt-2 border-top">
                            <b-button variant="warning" class="w-100 font-weight-bold text-dark mb-2 py-2" @click="openInEditor">
                                <font-awesome-icon icon="edit" class="mr-2" />
                                Open in Threat Dragon
                            </b-button>
                            <b-button v-if="refinementRound > 1" variant="outline-secondary" class="w-100 mb-2 py-2 font-weight-medium" @click="undoLastRefinement">
                                <font-awesome-icon icon="undo" class="mr-2" />
                                Desfazer Última Evolução
                            </b-button>
                            <b-button variant="outline-danger" class="w-100" size="sm" @click="resetForm">
                                Start Over
                            </b-button>
                        </div>
                    </b-card>
                </b-col>

                <!-- Right: Visual DFD Components & Validation Form -->
                <b-col md="7" class="mb-3">
                    <b-card class="shadow-sm border-0 h-100 d-flex flex-column" header-class="bg-warning text-dark py-2">
                        <template #header>
                            <h5 class="mb-0 font-weight-bold">
                                <font-awesome-icon icon="project-diagram" class="mr-2" />
                                DFD Visual Element Validation
                            </h5>
                        </template>

                        <!-- Tabs to switch between Visual Diagram and Element List -->
                        <b-tabs content-class="mt-3" class="mb-3">
                            <b-tab title="Visual DFD Diagram" active>
                                <div class="border rounded p-2 bg-white overflow-auto d-flex justify-content-center" style="max-height: 500px; min-height: 350px;">
                                    <td-read-only-diagram 
                                        v-if="generatedModel && generatedModel.detail && generatedModel.detail.diagrams && generatedModel.detail.diagrams[0]" 
                                        :diagram="generatedModel.detail.diagrams[0]" 
                                    />
                                    <div v-else class="text-center text-muted py-4 w-100">No diagram preview available.</div>
                                </div>
                            </b-tab>
                            <b-tab title="DFD Elements List">
                                <div class="element-list overflow-auto p-2 bg-light border rounded" style="max-height: 500px; min-height: 350px;">
                                    <div v-for="(elem, idx) in previewElements" :key="idx" class="font-size-sm py-2 border-bottom d-flex justify-content-between align-items-center">
                                        <span>
                                            <b-badge :variant="elem.type === 'Actor' ? 'primary' : elem.type === 'Process' ? 'warning text-dark' : 'success'">
                                                {{ elem.type }}
                                            </b-badge>
                                            <strong class="ml-2">{{ elem.name }}</strong>
                                        </span>
                                    </div>
                                </div>
                            </b-tab>
                        </b-tabs>

                        <!-- Option 1: Confirm and Proceed -->
                        <div class="approve-box bg-light border border-success rounded p-3 mb-3 text-center">
                            <h6 class="font-weight-bold text-success mb-2">
                                <font-awesome-icon icon="check" class="mr-1 text-success" />
                                Is the DFD structure complete?
                            </h6>
                            <p class="font-size-xs text-muted mb-3">
                                If the diagram accurately represents your network/application topology, click below to validate it and proceed to generate STRIDE/MITRE threats and security controls.
                            </p>
                            <b-button variant="success" class="font-weight-bold w-100 py-2 shadow-sm" @click="approveDfd">
                                <font-awesome-icon icon="check" class="mr-2" />
                                Yes, DFD is Complete (Proceed to Threats)
                            </b-button>
                        </div>

                        <!-- Option 2: Request modifications -->
                        <b-form @submit.prevent="submitDfdRefinement">
                            <b-form-group label="No, the DFD is too simple or missing elements (Request adjustments):" label-class="font-weight-bold font-size-sm text-danger">
                                <b-form-textarea
                                    v-model="userResponse"
                                    rows="2"
                                    required
                                    placeholder="e.g. 'Add Azure Key Vault component connected to Account Management Service', or 'Falta o banco de dados CosmosDB conectado ao microsserviço de cartões'..."
                                    class="custom-input font-size-sm"
                                ></b-form-textarea>
                            </b-form-group>

                            <div class="text-right">
                                <b-button type="submit" variant="warning" class="font-weight-bold text-dark px-4 py-2">
                                    <font-awesome-icon icon="redo" class="mr-2" />
                                    Refine & Re-generate DFD
                                </b-button>
                            </div>
                        </b-form>
                    </b-card>
                </b-col>
            </b-row>

            <!-- Refinement / Interactive Loop View -->
            <b-row v-else-if="step === 'interactive'" class="mb-4">
                <!-- Left: Model Preview Stats & Threat List -->
                <b-col md="5" class="mb-3">
                    <b-card class="shadow-sm border-0 h-100" header-class="bg-dark text-white py-2">
                        <template #header>
                            <h5 class="mb-0 font-weight-bold">Current Model Preview</h5>
                        </template>

                        <!-- Stats summary -->
                        <b-row class="text-center mb-3">
                            <b-col cols="4" class="px-1">
                                <div class="py-2 bg-light border rounded">
                                    <h4 class="font-weight-bold text-primary mb-0">{{ stats.elements }}</h4>
                                    <small class="text-muted font-size-xs">Components</small>
                                </div>
                            </b-col>
                            <b-col cols="4" class="px-1">
                                <div class="py-2 bg-light border rounded">
                                    <h4 class="font-weight-bold text-success mb-0">{{ stats.flows }}</h4>
                                    <small class="text-muted font-size-xs">Flows</small>
                                </div>
                            </b-col>
                            <b-col cols="4" class="px-1">
                                <div class="py-2 bg-light border rounded">
                                    <h4 class="font-weight-bold text-danger mb-0">{{ stats.threats }}</h4>
                                    <small class="text-muted font-size-xs">Threats</small>
                                </div>
                            </b-col>
                        </b-row>

                        <!-- Completeness Score Card -->
                        <div class="completeness-score-box bg-light border rounded p-3 mb-3 text-center">
                            <h6 class="font-weight-bold text-muted mb-1">
                                <span v-if="!dfdApproved">DFD Completeness Score</span>
                                <span v-else>Threat Model Completeness Score</span>
                            </h6>
                            <div class="d-flex align-items-center justify-content-center mb-2">
                                <h2 class="font-weight-bold mb-0 text-success" style="font-size: 2.2rem;">
                                    <span v-if="previousScore !== null && previousScore !== (evaluation ? evaluation.completenessScore : 0)" class="text-muted mr-2" style="font-size: 1.2rem; text-decoration: line-through;">
                                        {{ previousScore }}%
                                    </span>
                                    {{ evaluation ? evaluation.completenessScore : 0 }}%
                                    <span v-if="previousScore !== null && (evaluation ? evaluation.completenessScore : 0) > previousScore" class="text-success ml-2" style="font-size: 1.2rem;">
                                        &nbsp;📈 +{{ (evaluation ? evaluation.completenessScore : 0) - previousScore }}%
                                    </span>
                                </h2>
                            </div>
                            <div v-if="evaluation" class="font-size-xs text-left text-muted mt-2 border-top pt-2">
                                <div class="d-flex justify-content-between mb-1">
                                    <span>Component Coverage:</span>
                                    <span class="font-weight-bold">{{ evaluation.criteria.elementCoverage }}%</span>
                                </div>
                                <div class="d-flex justify-content-between mb-1">
                                    <span>Threat Mapping Completeness:</span>
                                    <span class="font-weight-bold">{{ evaluation.criteria.mitigationCompleteness }}%</span>
                                </div>
                                <div class="d-flex justify-content-between">
                                    <span>Remaining Questions:</span>
                                    <span class="font-weight-bold text-danger">{{ evaluation.criteria.unresolvedQuestionsCount }}</span>
                                </div>
                            </div>
                            <!-- Status badge -->
                            <div class="mt-2">
                                <span v-if="threatModelApproved" class="badge badge-success py-1 px-3 font-weight-bold">
                                    <font-awesome-icon icon="check-double" class="mr-1" />
                                    Status: Concluído e Aprovado
                                </span>
                                <span v-else class="badge py-1 px-3 font-weight-bold" :class="evaluation && evaluation.status === 'Ready' ? 'badge-success' : 'badge-warning text-dark'">
                                    Status: {{ evaluation ? evaluation.status : 'Refining' }}
                                </span>
                            </div>
                            <!-- Critique feedback text -->
                            <div v-if="evaluation && evaluation.feedback" class="mt-3 text-left border-top pt-2 font-size-xs">
                                <div class="font-weight-bold text-dark mb-1">
                                    <font-awesome-icon icon="info-circle" class="mr-1 text-info" />
                                    <span v-if="!dfdApproved">Crítica do DFD (DFDCriticAgent):</span>
                                    <span v-else>Crítica de Ameaças & Controles (ThreatCriticAgent):</span>
                                </div>
                                <div class="text-muted" style="line-height: 1.35; white-space: pre-wrap;">{{ evaluation.feedback }}</div>
                            </div>

                            <!-- Missing elements / boundaries / metadata lists from Critic -->
                            <div v-if="!dfdApproved && evaluation && evaluation.criteria" class="mt-3 text-left border-top pt-2 font-size-xs">
                                <div v-if="evaluation.criteria.missingElements && evaluation.criteria.missingElements.length > 0" class="mb-2">
                                    <div class="font-weight-bold text-danger mb-1">
                                        <font-awesome-icon icon="exclamation-triangle" class="mr-1" />
                                        Componentes / Fluxos Faltantes:
                                    </div>
                                    <ul class="pl-3 mb-0 text-muted" style="list-style-type: square;">
                                        <li v-for="(item, idx) in evaluation.criteria.missingElements" :key="idx" class="mb-1">{{ item }}</li>
                                    </ul>
                                </div>
                                <div v-if="evaluation.criteria.missingBoundaries && evaluation.criteria.missingBoundaries.length > 0" class="mb-2">
                                    <div class="font-weight-bold text-danger mb-1">
                                        <font-awesome-icon icon="exclamation-triangle" class="mr-1" />
                                        Boundaries Faltantes:
                                    </div>
                                    <ul class="pl-3 mb-0 text-muted" style="list-style-type: square;">
                                        <li v-for="(item, idx) in evaluation.criteria.missingBoundaries" :key="idx" class="mb-1">{{ item }}</li>
                                    </ul>
                                </div>
                                <div v-if="evaluation.criteria.missingMetadata && evaluation.criteria.missingMetadata.length > 0" class="mb-2">
                                    <div class="font-weight-bold text-danger mb-1">
                                        <font-awesome-icon icon="exclamation-triangle" class="mr-1" />
                                        Metadados / Descrições Faltantes:
                                    </div>
                                    <ul class="pl-3 mb-0 text-muted" style="list-style-type: square;">
                                        <li v-for="(item, idx) in evaluation.criteria.missingMetadata" :key="idx" class="mb-1">{{ item }}</li>
                                    </ul>
                                </div>
                            </div>
                        </div>

                        <!-- Element Lists -->
                        <h6 class="font-weight-bold border-bottom pb-1">Identified System Elements</h6>
                        <div class="element-list mb-3 overflow-auto" style="max-height: 180px;">
                            <div v-for="(elem, idx) in previewElements" :key="idx" class="font-size-sm py-1 border-bottom d-flex justify-content-between">
                                <span><strong>{{ elem.type }}:</strong> {{ elem.name }}</span>
                                <b-badge variant="danger" v-if="elem.threatsCount">{{ elem.threatsCount }} threats</b-badge>
                            </div>
                        </div>

                        <!-- Action buttons directly below stats -->
                        <div class="mt-3 pt-2 border-top">
                            <b-button variant="warning" class="w-100 font-weight-bold text-dark mb-2 py-2" @click="openInEditor">
                                <font-awesome-icon icon="edit" class="mr-2" />
                                Open in Threat Dragon
                            </b-button>
                            <b-button variant="info" class="w-100 mb-2 py-2 font-weight-bold" @click="downloadAssessmentReport">
                                <font-awesome-icon icon="file-alt" class="mr-2" />
                                Download Assessment Report
                            </b-button>
                            <b-button variant="secondary" class="w-100 mb-2 py-2" @click="downloadJson">
                                <font-awesome-icon icon="cloud-download-alt" class="mr-2" />
                                Download Model JSON
                            </b-button>
                            <b-button variant="outline-danger" class="w-100" size="sm" @click="resetForm">
                                Start Over
                            </b-button>
                        </div>
                    </b-card>

                    <!-- Security Control Efficacy Card -->
                    <b-card v-if="evaluation && evaluation.controlsAssessment && evaluation.controlsAssessment.length > 0" class="shadow-sm border-0 mt-3 text-left" header-class="bg-info text-white py-2">
                        <template #header>
                            <h6 class="mb-0 font-weight-bold">
                                <font-awesome-icon icon="check" class="mr-2" />
                                Security Control Efficacy
                            </h6>
                        </template>

                        <div class="control-assessment-list overflow-auto" style="max-height: 250px;">
                            <div v-for="(item, idx) in evaluation.controlsAssessment" :key="idx" class="p-2 border-bottom font-size-xs">
                                <div class="d-flex justify-content-between align-items-center mb-1">
                                    <span class="font-weight-bold text-dark">{{ item.securityControl }}</span>
                                    <b-badge :variant="item.assessment === 'Eficaz' ? 'success' : 'warning'" class="text-dark font-weight-bold">
                                        {{ item.assessment }}
                                    </b-badge>
                                </div>
                                <div class="text-muted mb-1" style="font-style: italic;">"{{ item.userAnswer }}"</div>
                                <div class="text-secondary" style="line-height: 1.3;">{{ item.details }}</div>
                            </div>
                        </div>
                    </b-card>
                </b-col>

                <!-- Right: Interactive Chat / Refinement Panel -->
                <b-col md="7" class="mb-3">
                    <b-card class="shadow-sm border-0 h-100 d-flex flex-column" header-class="bg-warning text-dark py-2">
                        <template #header>
                            <h5 class="mb-0 font-weight-bold">
                                <font-awesome-icon icon="robot" class="mr-2" />
                                Model Refinement Round {{ refinementRound }}
                            </h5>
                        </template>

                        <!-- Congratulations Panel if Approved -->
                        <div v-if="threatModelApproved" class="text-center py-5 d-flex flex-column justify-content-center align-items-center flex-grow-1">
                            <div class="mb-4 text-success">
                                <font-awesome-icon icon="check-double" size="4x" />
                            </div>
                            <h4 class="font-weight-bold text-success">Modelo de Ameaças Aprovado!</h4>
                            <p class="text-muted px-4 mt-3">
                                O processo de modelagem de ameaças para o sistema <strong>{{ form.title }}</strong> foi finalizado e aprovado por você.
                            </p>
                            <p class="text-muted px-4 font-size-xs">
                                Agora você pode baixar o relatório completo da avaliação ou o JSON final do modelo para importar no Threat Dragon.
                            </p>
                            <div class="mt-4 w-75">
                                <b-button variant="outline-primary" class="w-100 py-2 font-weight-bold" @click="undoLastRefinement">
                                    <font-awesome-icon icon="undo" class="mr-2" />
                                    Reverter Aprovação (Voltar a Refinar)
                                </b-button>
                            </div>
                        </div>

                        <!-- Q&A Refinement Loop if NOT Approved -->
                        <div v-else class="d-flex flex-column flex-grow-1">
                            <!-- Agent Questions Box -->
                            <div v-if="questions.length > 0" class="agent-questions-box bg-light border border-warning rounded p-3 mb-3">
                                <h6 class="font-weight-bold text-warning-dark mb-2">
                                    <font-awesome-icon icon="question-circle" class="mr-1" />
                                    Agent's Clarifying Questions:
                                </h6>
                                <ul class="pl-3 mb-0 font-size-sm">
                                    <li v-for="(q, idx) in questions" :key="idx" class="mb-2">{{ q }}</li>
                                </ul>
                            </div>
                            <div v-else class="alert alert-success py-2 font-size-sm mb-3">
                                <font-awesome-icon icon="check" class="mr-1" />
                                No further clarifying questions! The agent has all required info, but you can still request manual changes.
                            </div>

                            <!-- Chat refinement thread -->
                            <h6 class="font-weight-bold border-bottom pb-1">Refinement History</h6>
                            <div class="chat-thread flex-grow-1 overflow-auto p-2 bg-light border rounded mb-3" style="max-height: 200px; min-height: 120px;">
                                <div v-for="(msg, idx) in refinementHistory" :key="idx" class="mb-2 font-size-sm">
                                    <div :class="msg.role === 'user' ? 'text-right' : 'text-left'">
                                        <span class="badge py-1 px-2" :class="msg.role === 'user' ? 'badge-primary' : 'badge-dark'">
                                            {{ msg.role === 'user' ? 'You' : 'AI Agent' }}
                                        </span>
                                        <div class="d-inline-block rounded p-2 mt-1 max-w-75 text-left border"
                                             :class="msg.role === 'user' ? 'bg-primary-light border-primary-light text-dark' : 'bg-white text-dark'">
                                            <div style="white-space: pre-wrap;">{{ msg.text }}</div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- Answering field -->
                            <b-form @submit.prevent="submitRefinement">
                                <b-form-group label="Your Answers / Feedback:" label-class="font-weight-bold font-size-sm">
                                    <b-form-textarea
                                        v-model="userResponse"
                                        rows="3"
                                        required
                                        placeholder="Answer the questions above or request modifications (e.g. 'Add a Redis cache storage connected to the Backend worker')..."
                                        class="custom-input font-size-sm"
                                    ></b-form-textarea>
                                </b-form-group>

                                <div class="d-flex justify-content-between align-items-center">
                                    <b-button type="submit" variant="warning" class="font-weight-bold text-dark px-4 py-2">
                                        <font-awesome-icon icon="robot" class="mr-2" />
                                        Submit Answers & Refine
                                    </b-button>
                                    
                                    <b-button v-if="evaluation && evaluation.completenessScore >= 80" variant="success" class="font-weight-bold text-white px-4 py-2" @click="approveThreatModel">
                                        <font-awesome-icon icon="check-double" class="mr-2" />
                                        Approve & Conclude
                                    </b-button>
                                </div>
                            </b-form>
                        </div>
                    </b-card>
                </b-col>
            </b-row>

            <!-- Loading Proposals View -->
            <b-card v-else-if="step === 'generating-proposals'" class="shadow-lg border-0 mb-4 py-5 text-center">
                <div class="loading-container py-5 text-center">
                    <b-spinner variant="success" label="Spinning" class="mb-3" style="width: 4rem; height: 4rem;"></b-spinner>
                    <h3 class="font-weight-bold text-success mt-3">Analisando duplicatas e redundâncias...</h3>
                    <p class="text-muted">Aguarde enquanto identificamos oportunidades de deduplicação sem perda de contexto.</p>
                </div>
            </b-card>

            <!-- Deduplication Review View -->
            <b-card v-else-if="step === 'deduplicate-review'" class="shadow-lg border-0 mb-4">
                <template #header>
                    <div class="d-flex justify-content-between align-items-center py-2">
                        <div class="text-left">
                            <h4 class="mb-0 font-weight-bold text-success">
                                <font-awesome-icon icon="compress-arrows-alt" class="mr-2" />
                                Revisão e Deduplicação Manual
                            </h4>
                            <small class="text-muted">Selecione quais unificações deseja aprovar antes de concluir o modelo de ameaças.</small>
                        </div>
                        <b-badge variant="success" class="px-3 py-2 font-size-sm">Human-in-the-Loop</b-badge>
                    </div>
                </template>

                <b-row class="text-left">
                    <!-- Controls Deduplication Card -->
                    <b-col md="6" class="mb-3">
                        <b-card class="border-0 shadow-sm h-100 bg-light" header-class="bg-info text-white py-2">
                            <template #header>
                                <h5 class="mb-0 font-weight-bold font-size-md">
                                    <font-awesome-icon icon="shield-alt" class="mr-2" />
                                    Relatório de Eficácia de Controles ({{ deduplicateProposals && deduplicateProposals.controlDeduplications ? deduplicateProposals.controlDeduplications.length : 0 }})
                                </h5>
                            </template>

                            <div v-if="!deduplicateProposals || !deduplicateProposals.controlDeduplications || deduplicateProposals.controlDeduplications.length === 0" class="text-center py-5">
                                <font-awesome-icon icon="check-circle" size="3x" class="text-success mb-3" />
                                <p class="text-muted font-weight-bold">Nenhuma redundância encontrada nos controles.</p>
                            </div>

                            <div v-else>
                                <div
                                    v-for="proposal in deduplicateProposals.controlDeduplications"
                                    :key="proposal.id"
                                    class="bg-white border rounded p-3 mb-3 shadow-sm"
                                >
                                    <div class="d-flex justify-content-between align-items-start border-bottom pb-2 mb-2">
                                        <b-form-checkbox
                                            v-model="selectedControlDups"
                                            :value="proposal.id"
                                            class="font-weight-bold text-info"
                                        >
                                            Unificar Controles em: <b-badge variant="info">{{ proposal.controlCategory }}</b-badge>
                                        </b-form-checkbox>
                                    </div>

                                    <div class="font-size-xs text-muted mb-2">
                                        <strong>Itens a serem mesclados:</strong>
                                        <ul class="pl-3 mt-1 mb-2">
                                            <li v-for="(item, iIdx) in proposal.itemsToMerge" :key="iIdx">
                                                <em>Resposta:</em> "{{ item.userAnswer }}"
                                            </li>
                                        </ul>
                                    </div>

                                    <div class="border rounded p-2 bg-light font-size-xs">
                                        <strong class="text-success"><font-awesome-icon icon="arrow-right" class="mr-1"/> Resposta Unificada Proposta:</strong>
                                        <p class="mb-1 mt-1 font-weight-medium text-dark">"{{ proposal.proposedMergedItem.userAnswer }}"</p>
                                        <strong class="text-success"><font-awesome-icon icon="comment-dots" class="mr-1"/> Recomendações Unificadas:</strong>
                                        <p class="mb-0 text-muted">"{{ proposal.proposedMergedItem.details }}"</p>
                                    </div>
                                </div>
                            </div>
                        </b-card>
                    </b-col>

                    <!-- Threats Deduplication Card -->
                    <b-col md="6" class="mb-3">
                        <b-card class="border-0 shadow-sm h-100 bg-light" header-class="bg-danger text-white py-2">
                            <template #header>
                                <h5 class="mb-0 font-weight-bold font-size-md">
                                    <font-awesome-icon icon="bug" class="mr-2" />
                                    Ameaças no Modelo ({{ deduplicateProposals && deduplicateProposals.threatDeduplications ? deduplicateProposals.threatDeduplications.length : 0 }})
                                </h5>
                            </template>

                            <div v-if="!deduplicateProposals || !deduplicateProposals.threatDeduplications || deduplicateProposals.threatDeduplications.length === 0" class="text-center py-5">
                                <font-awesome-icon icon="check-circle" size="3x" class="text-success mb-3" />
                                <p class="text-muted font-weight-bold">Nenhuma redundância encontrada nas ameaças.</p>
                            </div>

                            <div v-else>
                                <div
                                    v-for="proposal in deduplicateProposals.threatDeduplications"
                                    :key="proposal.id"
                                    class="bg-white border rounded p-3 mb-3 shadow-sm"
                                >
                                    <div class="d-flex justify-content-between align-items-start border-bottom pb-2 mb-2">
                                        <b-form-checkbox
                                            v-model="selectedThreatDups"
                                            :value="proposal.id"
                                            class="font-weight-bold text-danger"
                                        >
                                            Unificar Ameaças em: <b-badge variant="danger">{{ proposal.cellName }}</b-badge>
                                        </b-form-checkbox>
                                    </div>

                                    <div class="font-size-xs text-muted mb-2">
                                        <strong>Ameaças a serem mescladas:</strong>
                                        <ul class="pl-3 mt-1 mb-2">
                                            <li v-for="(item, tIdx) in proposal.itemsToMerge" :key="tIdx">
                                                <strong>{{ item.title }}</strong>: "{{ item.description.substring(0, 80) }}..."
                                            </li>
                                        </ul>
                                    </div>

                                    <div class="border rounded p-2 bg-light font-size-xs">
                                        <strong class="text-danger"><font-awesome-icon icon="arrow-right" class="mr-1"/> Ameaça Unificada Proposta:</strong>
                                        <p class="mb-1 mt-1 font-weight-bold text-dark">{{ proposal.proposedMergedThreat.title }}</p>
                                        <strong class="text-danger"><font-awesome-icon icon="info-circle" class="mr-1"/> Descrição Unificada:</strong>
                                        <p class="mb-1 text-muted">"{{ proposal.proposedMergedThreat.description }}"</p>
                                        <strong class="text-danger"><font-awesome-icon icon="shield-alt" class="mr-1"/> Mitigação Unificada:</strong>
                                        <p class="mb-0 text-muted">"{{ proposal.proposedMergedThreat.mitigation }}"</p>
                                    </div>
                                </div>
                            </div>
                        </b-card>
                    </b-col>
                </b-row>

                <div class="d-flex justify-content-between align-items-center border-top pt-3 mt-3">
                    <b-button variant="outline-secondary" class="font-weight-bold" @click="cancelDeduplication">
                        <font-awesome-icon icon="arrow-left" class="mr-2" />
                        Voltar ao Refinamento
                    </b-button>
                    
                    <b-button variant="success" class="font-weight-bold text-white px-5 py-2 shadow-sm" @click="confirmDeduplicationAndApprove">
                        <font-awesome-icon icon="check-double" class="mr-2" />
                        Confirmar e Concluir Modelo
                    </b-button>
                </div>
            </b-card>

            <!-- Error Card -->
            <b-card
                v-else-if="step === 'error'"
                class="shadow-lg border-0 mb-4"
                header-class="bg-danger text-white border-0 py-3"
            >
                <template #header>
                    <div class="d-flex align-items-center">
                        <font-awesome-icon icon="exclamation-triangle" class="mr-3" size="lg" />
                        <h4 class="mb-0 font-weight-bold">{{ $t('aiThreatModeler.errorTitle') }}</h4>
                    </div>
                </template>

                <div class="alert alert-danger my-3">{{ errorMessage }}</div>

                <div class="text-right mt-4">
                    <b-button variant="secondary" class="px-4" @click="resetForm">
                        <font-awesome-icon icon="undo" class="mr-2" />
                        {{ $t('aiThreatModeler.tryAgain') }}
                    </b-button>
                </div>
            </b-card>
        </b-col>
    </b-row>
</template>

<script>
import { mapState } from 'vuex';
import axios from 'axios';
import { getProviderType } from '@/service/provider/providers.js';
import { PROVIDER_SELECTED } from '@/store/actions/provider.js';
import tmActions from '@/store/actions/threatmodel.js';
import TdFormSelect from '@/components/FormSelect.vue';
import TdReadOnlyDiagram from '@/components/ReadOnlyDiagram.vue';

export default {
    name: 'AIThreatModeler',
    components: {
        TdFormSelect,
        TdReadOnlyDiagram
    },
    data() {
        return {
            savedSessionId: localStorage.getItem('active_ai_session_id') || null,
            recentSessions: [],
            step: 'input', // 'input', 'generating', 'interactive', 'error'
            form: {
                title: '',
                description: '',
                apiKey: '',
                methodology: 'STRIDE'
            },
            sessionId: null,
            evaluation: null,
            docs: [], // Array of { name, content }
            images: [], // Array of { name, data } (base64 string)
            progressIndex: 0,
            progressSteps: [
                { label: 'Reading uploaded documents (parsing DOCX)...', state: 'pending' },
                { label: 'Formulating architectural context and STRIDE rules...', state: 'pending' },
                { label: 'Invoking Gemini model to analyze system diagrams...', state: 'pending' },
                { label: 'Running component-level threat generation...', state: 'pending' },
                { label: 'Building refined diagram JSON & questions...', state: 'pending' }
            ],
            generatedModel: null,
            questions: [],
            refinementHistory: [], // Array of { role: 'user'|'model', text: string }
            userResponse: '',
            refinementRound: 1,
            previousScore: null,
            dfdApproved: false,
            threatModelApproved: false,
            deduplicateProposals: null,
            selectedControlDups: [],
            selectedThreatDups: [],
            stats: {
                elements: 0,
                flows: 0,
                threats: 0
            },
            previewElements: [], // list of elements parsed for stats
            errorMessage: ''
        };
    },
    computed: mapState({
        providerType: (state) => getProviderType(state.provider.selected || 'local'),
        version: (state) => state.packageBuildVersion,
        existingModel: (state) => state.threatmodel.data
    }),
    watch: {
        existingModel: {
            immediate: true,
            handler(newModel) {
                if (newModel && newModel.summary) {
                    if (!this.form.title) {
                        this.form.title = newModel.summary.title || '';
                    }
                    if (!this.form.description) {
                        this.form.description = newModel.summary.description || '';
                    }
                    this.generatedModel = newModel;
                }
            }
        }
    },
    mounted() {
        if (!this.$store.state.provider.selected) {
            this.$store.dispatch(PROVIDER_SELECTED, 'local');
        }
        const mappedModel = this.existingModel;
        if (mappedModel && mappedModel.summary) {
            this.form.title = mappedModel.summary.title || '';
            this.form.description = mappedModel.summary.description || '';
            this.generatedModel = mappedModel;
        }
        try {
            this.recentSessions = JSON.parse(localStorage.getItem('recent_ai_sessions') || '[]');
            if (this.recentSessions.length === 0 && this.savedSessionId) {
                axios.get(`/api/ai/session/${this.savedSessionId}`).then(response => {
                    const result = response.data.data;
                    if (result && result.sessionId) {
                        const newSession = {
                            sessionId: result.sessionId,
                            title: result.title || 'Restored Active Session',
                            methodology: result.methodology || 'STRIDE',
                            timestamp: Date.now()
                        };
                        this.recentSessions = [newSession];
                        localStorage.setItem('recent_ai_sessions', JSON.stringify(this.recentSessions));
                    }
                }).catch(err => {
                    console.error('Could not auto-import active session:', err);
                });
            }
        } catch (e) {
            this.recentSessions = [];
        }

        if (this.savedSessionId && this.$route.query.resume === 'true') {
            this.resumeSession(this.savedSessionId);
        }
    },
    methods: {
        triggerFileInput(id) {
            document.getElementById(id).click();
        },
        // Docs Drop / Select (supporting docx, txt, md)
        onDocDrop(evt) {
            const files = evt.dataTransfer.files;
            this.handleDocs(files);
        },
        onDocSelect(evt) {
            const files = evt.target.files;
            this.handleDocs(files);
        },
        handleDocs(files) {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (file.name.endsWith('.txt') || file.name.endsWith('.md')) {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        this.docs.push({
                            name: file.name,
                            content: e.target.result
                        });
                    };
                    reader.readAsText(file);
                } else if (file.name.endsWith('.docx') || file.name.toLowerCase().endsWith('.pdf')) {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        this.docs.push({
                            name: file.name,
                            content: e.target.result // Base64 Data URL
                        });
                    };
                    reader.readAsDataURL(file);
                } else {
                    this.$toast.warning('Only .txt, .md, .docx and .pdf files are supported.');
                }
            }
        },
        removeDoc(idx) {
            this.docs.splice(idx, 1);
        },
        // Images Drop / Select
        onImageDrop(evt) {
            const files = evt.dataTransfer.files;
            this.handleImages(files);
        },
        onImageSelect(evt) {
            const files = evt.target.files;
            this.handleImages(files);
        },
        handleImages(files) {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (file.type.startsWith('image/')) {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        this.images.push({
                            name: file.name,
                            data: e.target.result
                        });
                    };
                    reader.readAsDataURL(file);
                } else {
                    this.$toast.warning('Please select image files only.');
                }
            }
        },
        removeImage(idx) {
            this.images.splice(idx, 1);
        },
        // Progress UI Helpers
        getProgressStepClass(idx) {
            if (this.progressIndex > idx) return 'text-success font-weight-bold';
            if (this.progressIndex === idx) return 'text-warning font-weight-bold';
            return 'text-muted';
        },
        getProgressStepIcon(idx) {
            if (this.progressIndex > idx) return 'check';
            if (this.progressIndex === idx) return 'circle';
            return 'circle';
        },
        getProgressStepIconClass(idx) {
            if (this.progressIndex > idx) return 'text-success';
            if (this.progressIndex === idx) return 'text-warning animate-pulse';
            return 'text-secondary';
        },
        // Initial Generation
        async generateModel() {
            this.step = 'generating';
            this.progressIndex = 0;
            this.refinementRound = 1;
            this.refinementHistory = [];
            this.progressSteps.forEach(step => step.state = 'pending');

            // Steps animations
            this.progressIndex = 1;
            await new Promise(resolve => setTimeout(resolve, 1000));
            this.progressIndex = 2;
            await new Promise(resolve => setTimeout(resolve, 1000));
            this.progressIndex = 3;

            try {
                const payload = {
                    title: this.form.title,
                    description: this.form.description,
                    docs: this.docs,
                    images: this.images,
                    apiKey: this.form.apiKey,
                    methodology: this.form.methodology,
                    currentModel: this.generatedModel
                };

                const response = await axios.post('/api/ai/threatmodel', payload);
                
                this.progressIndex = 4;
                await new Promise(resolve => setTimeout(resolve, 800));
                this.progressIndex = 5;

                const result = response.data.data;
                this.updateLocalState(result);

                // Add initial questions to chat thread
                if (this.questions.length > 0) {
                    this.refinementHistory.push({
                        role: 'model',
                        text: 'Welcome! I have mapped your initial architecture. Please answer these questions to help me refine the threat model:\n\n' + 
                              this.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
                    });
                }

                this.dfdApproved = false;
                this.step = 'validate-dfd';

            } catch (err) {
                console.error(err);
                this.errorMessage = err.response?.data?.message || err.message || 'An error occurred during threat model generation.';
                this.step = 'error';
            }
        },
        // Refinement Round Submission
        async submitRefinement() {
            if (!this.userResponse.trim()) return;

            const responseText = this.userResponse;
            this.refinementHistory.push({
                role: 'user',
                text: responseText
            });
            this.userResponse = '';

            this.step = 'generating';
            this.progressSteps.forEach(step => step.state = 'pending');
            this.progressIndex = 1;
            await new Promise(resolve => setTimeout(resolve, 1000));
            this.progressIndex = 2;
            await new Promise(resolve => setTimeout(resolve, 1000));
            this.progressIndex = 3;

            try {
                const payload = {
                    title: this.form.title,
                    description: this.form.description,
                    apiKey: this.form.apiKey,
                    currentModel: this.generatedModel,
                    refinementHistory: this.refinementHistory,
                    sessionId: this.sessionId,
                    methodology: this.form.methodology,
                    dfdApproved: this.dfdApproved,
                    threatModelApproved: this.threatModelApproved
                };

                const response = await axios.post('/api/ai/threatmodel', payload);

                this.progressIndex = 4;
                await new Promise(resolve => setTimeout(resolve, 800));
                this.progressIndex = 5;

                const result = response.data.data;
                this.updateLocalState(result);

                this.refinementRound++;

                // Append follow-up questions
                if (this.questions.length > 0) {
                    this.refinementHistory.push({
                        role: 'model',
                        text: 'Thanks! Based on your feedback, I have updated the model. Here is my next round of questions:\n\n' + 
                              this.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
                    });
                } else {
                    this.refinementHistory.push({
                        role: 'model',
                        text: 'Model refined successfully! I have no further questions. You can refine it again if you have more changes, or open the model in Threat Dragon.'
                    });
                }

                if (this.dfdApproved) {
                    this.step = 'interactive';
                } else {
                    this.step = 'validate-dfd';
                }

            } catch (err) {
                console.error(err);
                this.errorMessage = err.response?.data?.message || err.message || 'An error occurred during threat model refinement.';
                this.step = 'error';
            }
        },
        updateLocalState(result) {
            const model = result.threatModel;
            model.version = this.version;
            this.generatedModel = model;
            this.questions = result.questions || [];
            this.sessionId = result.sessionId || null;
            if (result.dfdApproved !== undefined) {
                this.dfdApproved = result.dfdApproved;
            }
            if (result.threatModelApproved !== undefined) {
                this.threatModelApproved = result.threatModelApproved;
            }

            if (this.evaluation && this.evaluation.completenessScore !== undefined) {
                this.previousScore = this.evaluation.completenessScore;
            } else {
                this.previousScore = null;
            }
            this.evaluation = result.evaluation || null;

            if (this.sessionId) {
                localStorage.setItem('active_ai_session_id', this.sessionId);
                this.savedSessionId = this.sessionId;

                try {
                    let history = JSON.parse(localStorage.getItem('recent_ai_sessions') || '[]');
                    history = history.filter(s => s.sessionId !== this.sessionId);
                    history.unshift({
                        sessionId: this.sessionId,
                        title: this.form.title || (model.summary ? model.summary.title : '') || 'Untitled Threat Model',
                        methodology: this.form.methodology || 'STRIDE',
                        timestamp: Date.now()
                    });
                    if (history.length > 10) history = history.slice(0, 10);
                    localStorage.setItem('recent_ai_sessions', JSON.stringify(history));
                    this.recentSessions = history;
                } catch (e) {
                    console.error('Failed to update recent sessions list', e);
                }
            }

            // Stats computation
            let elements = 0;
            let flows = 0;
            let threats = 0;
            this.previewElements = [];

            if (model.detail && model.detail.diagrams) {
                model.detail.diagrams.forEach(diagram => {
                    if (diagram.cells) {
                        diagram.cells.forEach(cell => {
                            const name = cell.data?.name || cell.id;
                            let cellType = 'Component';
                            if (cell.shape === 'flow') {
                                flows++;
                                cellType = 'Data Flow';
                            } else if (cell.shape === 'trust-boundary-curve') {
                                cellType = 'Trust Boundary';
                            } else {
                                elements++;
                                if (cell.shape === 'actor') cellType = 'Actor';
                                if (cell.shape === 'store') cellType = 'Data Store';
                                if (cell.shape === 'process') cellType = 'Process';
                            }

                            const threatsCount = cell.data?.threats?.length || 0;
                            threats += threatsCount;

                            if (cell.shape !== 'trust-boundary-curve') {
                                this.previewElements.push({
                                    name,
                                    type: cellType,
                                    threatsCount
                                });
                            }
                        });
                    }
                });
            }

            this.stats = { elements, flows, threats };
        },
        openInEditor() {
            if (!this.generatedModel) return;
            this.$store.dispatch(tmActions.selected, this.generatedModel);
            const params = Object.assign({}, this.$route.params, {
                threatmodel: this.generatedModel.summary.title
            });
            this.$router.push({ name: `${this.providerType}ThreatModel`, params });
        },
        downloadJson() {
            if (!this.generatedModel) return;
            const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(this.generatedModel, null, 2));
            const downloadAnchor = document.createElement('a');
            downloadAnchor.setAttribute('href', dataStr);
            downloadAnchor.setAttribute('download', `${this.generatedModel.summary.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-threat-model.json`);
            document.body.appendChild(downloadAnchor);
            downloadAnchor.click();
            downloadAnchor.remove();
        },
        resetForm() {
            this.step = 'input';
            this.docs = [];
            this.images = [];
            this.sessionId = null;
            this.evaluation = null;
            this.generatedModel = null;
            this.clearSavedSession();
        },
        async undoLastRefinement() {
            if (!this.sessionId) return;
            this.step = 'generating';
            this.progressIndex = 4;
            this.errorMessage = '';

            try {
                const response = await axios.post('/api/ai/threatmodel/undo', {
                    sessionId: this.sessionId
                });
                const result = response.data.data;
                this.updateLocalState(result);
                this.refinementHistory = result.refinementHistory || [];
                const userMsgCount = this.refinementHistory.filter(m => m.role === 'user').length;
                this.refinementRound = userMsgCount + 1;

                if (this.dfdApproved) {
                    this.step = 'interactive';
                } else {
                    this.step = 'validate-dfd';
                }
            } catch (err) {
                console.error('Failed to undo last refinement round:', err);
                this.errorMessage = err.response?.data?.message || err.message || 'Error occurred while reverting to the previous round.';
                this.step = 'error';
            }
        },
        clearSavedSession() {
            localStorage.removeItem('active_ai_session_id');
            this.savedSessionId = null;
        },
        deleteSessionFromHistory(sessionId) {
            try {
                let history = JSON.parse(localStorage.getItem('recent_ai_sessions') || '[]');
                history = history.filter(s => s.sessionId !== sessionId);
                localStorage.setItem('recent_ai_sessions', JSON.stringify(history));
                this.recentSessions = history;
                
                if (this.savedSessionId === sessionId) {
                    localStorage.removeItem('active_ai_session_id');
                    this.savedSessionId = null;
                }
            } catch (e) {
                console.error(e);
            }
        },
        async resumeSession(sessionId) {
            try {
                const response = await axios.get(`/api/ai/session/${sessionId}`);
                const result = response.data.data;
                
                this.form.title = result.title || '';
                this.form.description = result.description || '';
                this.form.methodology = result.methodology || 'STRIDE';
                this.refinementHistory = result.refinementHistory || [];
                
                this.updateLocalState({
                    threatModel: this.generatedModel || result.threatModel,
                    questions: result.questions,
                    evaluation: result.evaluation,
                    sessionId: result.sessionId,
                    dfdApproved: result.dfdApproved || false,
                    threatModelApproved: result.threatModelApproved || false
                });
                
                const userMsgCount = this.refinementHistory.filter(m => m.role === 'user').length;
                this.refinementRound = userMsgCount + 1;

                if (this.dfdApproved) {
                    this.step = 'interactive';
                } else {
                    this.step = 'validate-dfd';
                }
            } catch (err) {
                console.error('Failed to resume session:', err);
                this.$toast.error('Failed to resume the session. It may have expired or been deleted.');
                this.clearSavedSession();
                this.step = 'input';
            }
        },
        async approveDfd() {
            this.dfdApproved = true;
            this.userResponse = 'Aprovado. O DFD está completo.';
            await this.submitRefinement();
        },
        async approveThreatModel() {
            this.step = 'generating-proposals';
            try {
                const response = await axios.get(`/api/ai/session/${this.sessionId}/deduplicate-proposals`);
                const proposals = response.data.data;
                
                const hasControls = proposals.controlDeduplications && proposals.controlDeduplications.length > 0;
                const hasThreats = proposals.threatDeduplications && proposals.threatDeduplications.length > 0;
                
                if (!hasControls && !hasThreats) {
                    await this.confirmDeduplicationAndApprove([], []);
                    return;
                }
                
                this.deduplicateProposals = proposals;
                this.selectedControlDups = (proposals.controlDeduplications || []).map(p => p.id);
                this.selectedThreatDups = (proposals.threatDeduplications || []).map(p => p.id);
                
                this.step = 'deduplicate-review';
            } catch (err) {
                await this.confirmDeduplicationAndApprove([], []);
            }
        },
        cancelDeduplication() {
            this.step = 'interactive';
        },
        async confirmDeduplicationAndApprove(controlDups = null, threatDups = null) {
            this.step = 'generating-proposals';
            
            const approvedControlIds = Array.isArray(controlDups) ? controlDups : this.selectedControlDups;
            const approvedThreatIds = Array.isArray(threatDups) ? threatDups : this.selectedThreatDups;

            try {
                const response = await axios.post(`/api/ai/session/${this.sessionId}/apply-deduplication`, {
                    approvedControlDeduplicationIds: approvedControlIds,
                    approvedThreatDeduplicationIds: approvedThreatIds
                });
                
                const data = response.data.data;
                this.generatedModel = data.threatModel;
                this.evaluation = data.evaluation;
                this.threatModelApproved = true;
                this.step = 'interactive';
            } catch (err) {
                this.errorMessage = err.message || 'Error occurred while applying deduplication';
                this.step = 'error';
            }
        },
        async submitDfdRefinement() {
            await this.submitRefinement();
        },
        downloadAssessmentReport() {
            if (!this.generatedModel || !this.evaluation) return;
            
            let markdown = `# Threat Modeling Assessment Report: ${this.form.title}\n\n`;
            markdown += `## Metadata\n`;
            markdown += `- **Description**: ${this.form.description || 'N/A'}\n`;
            markdown += `- **Methodology**: ${this.form.methodology}\n`;
            markdown += `- **Completeness Score**: ${this.evaluation.completenessScore}%\n`;
            markdown += `- **Status**: ${this.evaluation.status}\n\n`;
            
            markdown += `## Overall Critique\n${this.evaluation.feedback || 'No critique feedback available.'}\n\n`;
            
            markdown += `## Security Control Efficacy Report\n`;
            markdown += `Below is a summary of the controls discussed during the refinement rounds:\n\n`;
            
            if (this.evaluation.controlsAssessment && this.evaluation.controlsAssessment.length > 0) {
                markdown += `| Answer Provided | Security Control | Efficacy | Critique / Recommendations |\n`;
                markdown += `| --- | --- | --- | --- |\n`;
                this.evaluation.controlsAssessment.forEach((item) => {
                    const badge = item.assessment === 'Eficaz' ? '✅ Eficaz' : '⚠️ Carece Melhoria';
                    markdown += `| ${item.userAnswer.replace(/\n/g, ' ')} | ${item.securityControl} | ${badge} | ${item.details.replace(/\n/g, ' ')} |\n`;
                });
                markdown += `\n`;
            } else {
                markdown += `*No security controls have been assessed yet. Provide answers to the clarifying questions to generate assessments.*\n\n`;
            }
            
            markdown += `## Refinement History (Q&A)\n`;
            this.refinementHistory.forEach((msg, idx) => {
                const speaker = msg.role === 'user' ? 'User' : 'AI Modeler';
                markdown += `### Round ${idx + 1} - ${speaker}\n${msg.text}\n\n`;
            });
            
            const dataStr = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(markdown);
            const downloadAnchor = document.createElement('a');
            downloadAnchor.setAttribute('href', dataStr);
            downloadAnchor.setAttribute('download', `${this.form.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-assessment-report.md`);
            document.body.appendChild(downloadAnchor);
            downloadAnchor.click();
            downloadAnchor.remove();
        }
    }
};
</script>

<style lang="scss" scoped>
.ai-modeler-card {
    border-radius: 12px;
}

.custom-input {
    border: 1px solid #ced4da;
    border-radius: 6px;
    padding: 0.6rem 0.8rem;
    transition: border-color 0.15s ease-in-out, box-shadow 0.15s ease-in-out;
    &:focus {
        border-color: #f0ad4e;
        box-shadow: 0 0 0 0.2rem rgba(240, 173, 78, 0.25);
    }
}

.dropzone {
    border: 2px dashed #ccc;
    cursor: pointer;
    background-color: #fafafa;
    transition: background-color 0.2s, border-color 0.2s;
    &:hover {
        background-color: #f0f0f0;
        border-color: #f0ad4e;
    }
}

.border-dashed {
    border-style: dashed !important;
}

.font-size-sm {
    font-size: 0.875rem;
}

.font-size-xs {
    font-size: 0.75rem;
}

.text-warning-dark {
    color: #856404;
}

.bg-primary-light {
    background-color: rgba(0, 123, 255, 0.1);
}

.max-w-75 {
    max-width: 75%;
}

.chat-thread::-webkit-scrollbar {
    width: 6px;
}
.chat-thread::-webkit-scrollbar-thumb {
    background-color: rgba(0, 0, 0, 0.2);
    border-radius: 3px;
}

.animate-pulse {
    animation: pulse 1.5s infinite ease-in-out;
}

@keyframes pulse {
    0% {
        opacity: 0.4;
        transform: scale(0.95);
    }
    50% {
        opacity: 1;
        transform: scale(1.1);
    }
    100% {
        opacity: 0.4;
        transform: scale(0.95);
    }
}

.generate-btn {
    border-radius: 6px;
    transition: transform 0.1s;
    &:active {
        transform: scale(0.97);
    }
}
</style>
