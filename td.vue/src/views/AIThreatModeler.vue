<template>
    <b-row class="justify-content-center">
        <b-col md="11" lg="10">
            <div v-if="step === 'input'">
                <!-- Input Form Card -->
                <b-card
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
                                :label="form.aiProvider === 'bedrock-mantle' ? $t('aiThreatModeler.apiKeyOverrideBedrock') : $t('aiThreatModeler.apiKeyOverrideGemini')"
                                label-for="apiKey"
                                label-class="font-weight-bold"
                            >
                                <b-form-input
                                    id="apiKey"
                                    v-model="form.apiKey"
                                    type="password"
                                    :placeholder="form.aiProvider === 'bedrock-mantle' ? $t('aiThreatModeler.apiKeyPlaceholderBedrock') : $t('aiThreatModeler.apiKeyPlaceholderGemini')"
                                    class="custom-input"
                                ></b-form-input>
                            </b-form-group>
                        </b-col>
                    </b-form-row>

                    <!-- AI Provider Selection -->
                    <b-form-group
                        id="provider-group"
                        :label="$t('aiThreatModeler.aiProvider')"
                        label-for="aiProvider"
                        label-class="font-weight-bold"
                    >
                        <td-form-select
                            id="aiProvider"
                            v-model="form.aiProvider"
                            :options="[
                                { value: 'gemini', text: 'Google Gemini' },
                                { value: 'bedrock-mantle', text: 'Bedrock Mantle (OpenAI Compatible)' }
                            ]"
                        />
                    </b-form-group>

                    <b-form-row v-if="form.aiProvider === 'bedrock-mantle'">
                        <b-col md="6">
                            <b-form-group
                                id="base-url-group"
                                :label="$t('aiThreatModeler.baseUrl')"
                                label-for="customBaseUrl"
                                label-class="font-weight-bold"
                            >
                                <b-form-input
                                    id="customBaseUrl"
                                    v-model="form.customBaseUrl"
                                    type="text"
                                    placeholder="https://bedrock-mantle.us-east-1.api.aws/v1"
                                    class="custom-input"
                                ></b-form-input>
                            </b-form-group>
                        </b-col>
                        <b-col md="6">
                            <b-form-group
                                id="model-group"
                                :label="$t('aiThreatModeler.modelName')"
                                label-for="customModel"
                                label-class="font-weight-bold"
                            >
                                <b-form-input
                                    id="customModel"
                                    v-model="form.customModel"
                                    type="text"
                                    placeholder="meta.llama3-70b-instruct-v1:0"
                                    class="custom-input"
                                ></b-form-input>
                            </b-form-group>
                        </b-col>
                        <b-col md="12">
                            <b-form-checkbox
                                id="extendedThinking"
                                v-model="form.extendedThinking"
                                class="mb-3 font-weight-bold"
                            >
                                {{ $t('aiThreatModeler.extendedThinking') }}
                            </b-form-checkbox>
                        </b-col>
                    </b-form-row>

                    <b-form-row v-if="form.aiProvider === 'bedrock-mantle'">
                        <b-col md="12">
                            <b-form-checkbox
                                id="customizeStageModels"
                                v-model="form.customizeStageModels"
                                class="mb-3 font-weight-bold"
                            >
                                Personalizar modelo por etapa (Configurações Avançadas)
                            </b-form-checkbox>
                        </b-col>
                    </b-form-row>

                    <div v-if="form.aiProvider === 'bedrock-mantle' && form.customizeStageModels" class="advanced-stage-models p-3 mb-3 border rounded bg-light">
                        <h6 class="font-weight-bold mb-3 text-primary">Modelos por Etapa</h6>
                        
                        <!-- Etapa 1: Gerador de DFD/Ameaças -->
                        <b-form-row class="align-items-center mb-2">
                            <b-col md="3"><span class="font-weight-bold text-secondary small">1. Gerador (DFD/Ameaças)</span></b-col>
                            <b-col md="6">
                                <b-form-input
                                    v-model="form.generatorModel"
                                    type="text"
                                    placeholder="meta.llama3-70b-instruct-v1:0 (padrão)"
                                    class="custom-input form-control-sm"
                                ></b-form-input>
                            </b-col>
                            <b-col md="3">
                                <b-form-checkbox v-model="form.generatorExtendedThinking" class="small">
                                    Extended Thinking
                                </b-form-checkbox>
                            </b-col>
                        </b-form-row>

                        <!-- Etapa 2: Auditor / Crítico -->
                        <b-form-row class="align-items-center mb-2">
                            <b-col md="3"><span class="font-weight-bold text-secondary small">2. Crítico / Avaliador</span></b-col>
                            <b-col md="6">
                                <b-form-input
                                    v-model="form.criticModel"
                                    type="text"
                                    placeholder="meta.llama3-70b-instruct-v1:0 (padrão)"
                                    class="custom-input form-control-sm"
                                ></b-form-input>
                            </b-col>
                            <b-col md="3">
                                <b-form-checkbox v-model="form.criticExtendedThinking" class="small">
                                    Extended Thinking
                                </b-form-checkbox>
                            </b-col>
                        </b-form-row>

                        <!-- Etapa 3: Autocorreção / Revisão -->
                        <b-form-row class="align-items-center mb-2">
                            <b-col md="3"><span class="font-weight-bold text-secondary small">3. Autocorreção (Revisão)</span></b-col>
                            <b-col md="6">
                                <b-form-input
                                    v-model="form.revisionModel"
                                    type="text"
                                    placeholder="meta.llama3-70b-instruct-v1:0 (padrão)"
                                    class="custom-input form-control-sm"
                                ></b-form-input>
                            </b-col>
                            <b-col md="3">
                                <b-form-checkbox v-model="form.revisionExtendedThinking" class="small">
                                    Extended Thinking
                                </b-form-checkbox>
                            </b-col>
                        </b-form-row>

                        <!-- Etapa 4: Dedup (Otimização) -->
                        <b-form-row class="align-items-center">
                            <b-col md="3"><span class="font-weight-bold text-secondary small">4. Dedup (Otimização)</span></b-col>
                            <b-col md="6">
                                <b-form-input
                                    v-model="form.deduplicatorModel"
                                    type="text"
                                    placeholder="meta.llama3-70b-instruct-v1:0 (padrão)"
                                    class="custom-input form-control-sm"
                                ></b-form-input>
                            </b-col>
                            <b-col md="3">
                                <b-form-checkbox v-model="form.deduplicatorExtendedThinking" class="small">
                                    Extended Thinking
                                </b-form-checkbox>
                            </b-col>
                        </b-form-row>
                    </div>

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
                                        { value: 'LINDDUN', text: 'LINDDUN (Privacy Threats)' },
                                        { value: 'CIA', text: 'CIA (Confidentiality, Integrity, Availability)' },
                                        { value: 'DIE', text: 'DIE (Distributed, Immutable, Ephemeral)' },
                                        { value: 'MITRE_F3', text: 'MITRE F3 (Fraud Prevention Framework)' },
                                        { value: 'PLOT4ai', text: 'PLOT4ai (AI/ML Responsible Threats)' }
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

                    <!-- Requirements/Controls spreadsheet dropzone -->
                    <b-form-group label="Planilha de Requisitos / Controles Implementados (Opcional)" label-class="font-weight-bold">
                        <div
                            class="dropzone py-4 text-center border-dashed rounded mb-2"
                            style="border-color: #28a745;"
                            @dragover.prevent
                            @drop.prevent="onRequirementsDrop"
                            @click="triggerFileInput('reqFile')"
                        >
                            <font-awesome-icon icon="shield-alt" class="text-success mb-2" size="2x" />
                            <p class="mb-0 text-muted font-size-sm">Arraste ou clique para selecionar a planilha XLSX com os requisitos/controles</p>
                            <small class="text-muted">.xlsx (aba "Requisitos" será lida automaticamente)</small>
                            <input
                                id="reqFile"
                                type="file"
                                accept=".xlsx,.csv"
                                class="d-none"
                                @change="onRequirementsSelect"
                            />
                        </div>
                        <div v-if="requirementsFile" class="file-list p-2 bg-light border rounded border-success">
                            <div class="d-flex justify-content-between align-items-center font-size-sm py-1">
                                <span>
                                    <font-awesome-icon icon="check" class="text-success mr-2" />
                                    {{ requirementsFile.name }}
                                    <b-badge variant="success" class="ml-2">{{ parsedRequirements.length }} requisitos</b-badge>
                                </span>
                                <b-button size="sm" variant="link" class="text-danger p-0" @click="removeRequirements">
                                    <font-awesome-icon icon="trash" />
                                </b-button>
                            </div>
                        </div>
                    </b-form-group>

                    <!-- Session Password -->
                    <b-form-group
                        label="Senha da Sessão (Opcional)"
                        label-class="font-weight-bold"
                        description="Defina uma senha para proteger esta sessão e permitir que ela seja acessada em outros dispositivos/sessões com segurança."
                    >
                        <b-form-input
                            id="session-password"
                            v-model="form.password"
                            type="password"
                            placeholder="Defina uma senha para proteger esta sessão"
                            class="custom-input"
                        ></b-form-input>
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
                                <b-button size="sm" variant="outline-danger" class="font-weight-bold" @click="deleteSessionFromServer(session)">
                                    <font-awesome-icon icon="trash" />
                                </b-button>
                            </b-td>
                        </b-tr>
                    </b-tbody>
                </b-table-simple>
            </b-card>

            <!-- Server Sessions History -->
            <b-card
                class="ai-modeler-card shadow-sm border-0 mb-4"
                header-class="bg-dark text-white border-0 py-2"
            >
                <template #header>
                    <div class="d-flex align-items-center justify-content-between">
                        <div class="d-flex align-items-center">
                            <font-awesome-icon icon="server" class="mr-2 text-warning" />
                            <h5 class="mb-0 font-weight-bold">Active Sessions on Server</h5>
                        </div>
                        <b-button size="sm" variant="outline-light" class="py-1 font-weight-bold" @click="fetchServerSessions">
                            <font-awesome-icon icon="sync" class="mr-1" /> Refresh
                        </b-button>
                    </div>
                </template>
                
                <b-table-simple hover small responsive class="mb-0" v-if="serverSessions.length > 0">
                    <b-thead>
                        <b-tr>
                            <b-th>Title</b-th>
                            <b-th>Methodology</b-th>
                            <b-th>Last Saved</b-th>
                            <b-th>Security</b-th>
                            <b-th class="text-right">Actions</b-th>
                        </b-tr>
                    </b-thead>
                    <b-tbody>
                        <b-tr v-for="session in serverSessions" :key="session.sessionId">
                            <b-td class="align-middle font-weight-bold text-dark">{{ session.title }}</b-td>
                            <b-td class="align-middle">
                                <b-badge :variant="session.methodology === 'STRIDE' ? 'primary' : 'warning'">
                                    {{ session.methodology }}
                                </b-badge>
                            </b-td>
                            <b-td class="align-middle text-muted font-size-sm">
                                {{ new Date(session.updatedAt || session.createdAt).toLocaleString() }}
                            </b-td>
                            <b-td class="align-middle">
                                <span v-if="session.hasPassword" class="text-danger small font-weight-bold">
                                    <font-awesome-icon icon="lock" class="mr-1" /> Protected
                                </span>
                                <span v-else class="text-success small font-weight-bold">
                                    <font-awesome-icon icon="lock-open" class="mr-1" /> Public
                                </span>
                            </b-td>
                            <b-td class="text-right align-middle">
                                <b-button size="sm" variant="success" class="mr-2 font-weight-bold" @click="onPromptOrResume(session)">
                                    Resume
                                </b-button>
                                <b-button size="sm" variant="outline-danger" class="font-weight-bold" @click="deleteSessionFromServer(session)">
                                    <font-awesome-icon icon="trash" />
                                </b-button>
                            </b-td>
                        </b-tr>
                    </b-tbody>
                </b-table-simple>
                <div v-else class="text-center py-4 text-muted">
                    <p class="mb-0 font-italic">No active sessions found on server.</p>
                </div>
            </b-card>
            </div>




            <!-- Loading / Progress View -->
            <b-card v-else-if="step === 'generating'" class="shadow-lg border-0 mb-4 py-4 text-center">
                <div class="loading-container mb-4">
                    <b-spinner variant="warning" label="Spinning" class="mb-3" style="width: 3rem; height: 3rem;"></b-spinner>
                    <h4 class="font-weight-bold">{{ $t('aiThreatModeler.generating') }}</h4>
                </div>

                <div v-if="jobStatus" class="text-muted font-weight-bold mb-2">
                    Status: <span class="text-warning uppercase">{{ jobStatus }}</span> ({{ jobProgress }}%)
                </div>
                <b-progress :value="jobProgress" :max="100" show-progress animated variant="warning" class="my-3 mx-auto col-md-8 px-0"></b-progress>

                <div v-if="jobStreamText" class="text-left mx-auto col-md-8 px-3 py-2 border rounded bg-dark text-light mb-3" style="max-height: 200px; overflow-y: auto; font-family: monospace; white-space: pre-wrap; font-size: 0.85rem;">
                    <div class="small font-weight-bold text-warning border-bottom border-secondary pb-1 mb-2">Live AI Stream Preview</div>
                    {{ jobStreamText }}
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
                            <b-button variant="outline-danger" class="w-100 mb-2" size="sm" @click="resetForm">
                                Start Over
                            </b-button>
                        </div>

                        <!-- Collapsible Model Config Panel -->
                        <div class="mt-2 pt-2 border-top">
                            <b-button variant="link" size="sm" class="text-muted p-0 font-weight-bold" @click="showModelConfig = !showModelConfig">
                                <font-awesome-icon :icon="showModelConfig ? 'chevron-up' : 'chevron-down'" class="mr-1" />
                                {{ $t('aiThreatModeler.switchModel') || 'Switch AI Model' }}
                            </b-button>
                            <b-collapse v-model="showModelConfig" class="mt-2">
                                <div class="bg-light border rounded p-2">
                                    <b-form-group label="Model Name" label-class="font-weight-bold font-size-xs" class="mb-2">
                                        <b-form-input
                                            v-model="form.customModel"
                                            type="text"
                                            size="sm"
                                            placeholder="meta.llama3-70b-instruct-v1:0"
                                            class="custom-input font-size-sm"
                                        ></b-form-input>
                                    </b-form-group>
                                    <b-form-checkbox
                                        v-if="form.aiProvider === 'bedrock-mantle'"
                                        v-model="form.extendedThinking"
                                        size="sm"
                                        class="font-size-xs font-weight-bold"
                                    >
                                        {{ $t('aiThreatModeler.extendedThinking') }}
                                    </b-form-checkbox>
                                </div>
                            </b-collapse>
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
                            <b-button variant="primary" class="w-100 mb-2 py-2 font-weight-bold text-white" @click="downloadPdfReport">
                                <font-awesome-icon icon="file-pdf" class="mr-2" />
                                Download PDF Report
                            </b-button>
                            <b-button variant="info" class="w-100 mb-2 py-2 font-weight-bold" @click="downloadAssessmentReport">
                                <font-awesome-icon icon="file-alt" class="mr-2" />
                                Download Markdown Report
                            </b-button>
                            <b-button variant="secondary" class="w-100 mb-2 py-2" @click="downloadJson">
                                <font-awesome-icon icon="cloud-download-alt" class="mr-2" />
                                Download Model JSON
                            </b-button>
                            <b-button v-if="activeMitigationStatus && activeMitigationStatus.length > 0" variant="outline-success" class="w-100 mb-2 py-2 font-weight-bold" @click="viewMitigationStatus">
                                <font-awesome-icon icon="shield-alt" class="mr-2" />
                                Ver Status de Mitigação de Ameaças
                            </b-button>
                            <b-button v-if="sessionId && answeredQuestions && answeredQuestions.length > 0" variant="outline-info" class="w-100 mb-2 py-2 font-weight-bold" @click="viewQaReview">
                                <font-awesome-icon icon="history" class="mr-2" />
                                Revisão de Perguntas e Respostas
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
                            <div class="d-flex justify-content-between align-items-center">
                                <h5 class="mb-0 font-weight-bold">
                                    <font-awesome-icon icon="robot" class="mr-2" />
                                    Model Refinement Round {{ refinementRound }}
                                </h5>
                                <b-badge v-if="questionPlan" variant="dark" class="px-2 py-1 font-size-xs">
                                    {{ questionPlan.methodology }}
                                </b-badge>
                            </div>
                        </template>

                        <!-- Question Progress Bar (only shown when plan exists) -->
                        <div v-if="questionPlan && !threatModelApproved" class="question-progress-box bg-light border rounded p-3 mb-3">
                            <div class="d-flex justify-content-between align-items-center mb-2">
                                <h6 class="font-weight-bold text-dark mb-0">
                                    <font-awesome-icon icon="tasks" class="mr-1 text-warning" />
                                    {{ $t('aiThreatModeler.frameworkCoverage') }}
                                </h6>
                                <span class="font-weight-bold font-size-sm">
                                    {{ questionProgress.answered }}/{{ questionProgress.total }}
                                    <span class="text-muted font-size-xs ml-1">{{ $t('aiThreatModeler.questionsAnswered') }}</span>
                                </span>
                            </div>
                            <!-- Overall progress bar -->
                            <b-progress :max="100" height="20px" class="mb-2 shadow-sm">
                                <b-progress-bar
                                    :value="questionProgress.percentage"
                                    :variant="questionProgress.percentage >= 80 ? 'success' : questionProgress.percentage >= 50 ? 'warning' : 'info'"
                                    :label="questionProgress.percentage + '%'"
                                    animated
                                    striped
                                />
                            </b-progress>
                            <div class="font-size-xs text-muted mb-2">
                                {{ $t('aiThreatModeler.estimatedRounds') }}: ~{{ questionPlan.estimatedRounds }} | 
                                {{ questionProgress.total - questionProgress.answered }} {{ $t('aiThreatModeler.questionsRemaining') }}
                            </div>
                            <!-- Per-category mini progress -->
                            <div v-if="questionPlan.byCategory" class="category-progress mt-2 border-top pt-2">
                                <div class="font-weight-bold font-size-xs text-muted mb-1">{{ $t('aiThreatModeler.categoryProgress') }}</div>
                                <div v-for="(catData, catName) in questionPlan.byCategory" :key="catName" class="d-flex align-items-center mb-1">
                                    <span class="font-size-xs text-dark" style="min-width: 160px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ catName }}</span>
                                    <b-progress :max="catData.total || 1" height="10px" class="flex-grow-1 mx-2">
                                        <b-progress-bar
                                            :value="catData.answered"
                                            :variant="catData.answered >= catData.total ? 'success' : 'info'"
                                        />
                                    </b-progress>
                                    <span class="font-size-xs text-muted" style="min-width: 40px; text-align: right;">{{ catData.answered }}/{{ catData.total }}</span>
                                </div>
                            </div>
                        </div>

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
                            <div v-if="questions.length > 0" class="agent-questions-box mb-3">
                                <h6 class="font-weight-bold text-warning-dark mb-3">
                                    <font-awesome-icon icon="question-circle" class="mr-1" />
                                    Perguntas de Esclarecimento do Agente:
                                </h6>
                                <div v-for="(q, idx) in questions" :key="q.id || idx" class="mb-3 p-3 bg-white border rounded shadow-sm">
                                    <div class="font-weight-bold text-dark font-size-sm mb-2 d-flex justify-content-between">
                                        <span>
                                            <span class="badge badge-warning text-dark mr-2">Q{{ idx + 1 }}</span>
                                            <strong>{{ q.elementName || 'Componente' }}</strong> ({{ q.category || 'Geral' }})
                                        </span>
                                    </div>
                                    <div class="text-muted font-size-sm mb-2" style="font-style: italic;">
                                        {{ q.text || q }}
                                    </div>
                                    <b-form-textarea
                                        v-model="questionAnswers[q.id]"
                                        rows="2"
                                        placeholder="Digite sua resposta para esta pergunta específica..."
                                        class="custom-input font-size-sm"
                                    ></b-form-textarea>
                                </div>
                            </div>
                            <div v-else class="alert alert-success py-2 font-size-sm mb-3">
                                <font-awesome-icon icon="check" class="mr-1" />
                                Nenhuma pergunta pendente nesta rodada! O agente tem as informações necessárias, mas você ainda pode solicitar ajustes manuais abaixo.
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
                                <b-form-group label="Outros Comentários ou Solicitações Manuais (Opcional):" label-class="font-weight-bold font-size-sm">
                                    <b-form-textarea
                                        v-model="userResponse"
                                        rows="3"
                                        placeholder="Solicite modificações manuais adicionais (ex: 'Adicione um banco de dados Redis conectado ao componente Backend')..."
                                        class="custom-input font-size-sm"
                                    ></b-form-textarea>
                                </b-form-group>

                                <div class="d-flex justify-content-between align-items-center">
                                    <b-button type="submit" variant="warning" class="font-weight-bold text-dark px-4 py-2">
                                        <font-awesome-icon icon="robot" class="mr-2" />
                                        Submit Answers & Refine
                                    </b-button>
                                    
                                    <b-button
                                        v-if="evaluation"
                                        :disabled="questionProgress.answered < questionProgress.total"
                                        variant="success"
                                        class="font-weight-bold text-white px-4 py-2"
                                        @click="approveThreatModel"
                                    >
                                        <font-awesome-icon icon="check-double" class="mr-2" />
                                        Approve & Conclude
                                    </b-button>
                                </div>
                            </b-form>

                            <!-- Acceleration Tools Section -->
                            <div class="acceleration-tools mt-4 pt-3 border-top">
                                <h6 class="font-weight-bold text-dark mb-3">
                                    <font-awesome-icon icon="bolt" class="mr-1 text-warning" />
                                    Ferramentas de Aceleração
                                </h6>
                                <p class="font-size-xs text-muted mb-3">
                                    Use estas ferramentas para responder perguntas em massa via planilha CSV (para outra IA) ou subir requisitos/controles já implementados para auto-responder perguntas.
                                </p>

                                <div class="d-flex flex-wrap" style="gap: 8px;">
                                    <!-- Export CSV -->
                                    <b-button
                                        variant="outline-primary"
                                        size="sm"
                                        class="font-weight-bold"
                                        :disabled="accelerationLoading"
                                        @click="exportQuestionsCsv"
                                    >
                                        <font-awesome-icon icon="cloud-download-alt" class="mr-1" />
                                        Exportar Perguntas (CSV)
                                    </b-button>

                                    <!-- Import CSV -->
                                    <b-button
                                        variant="outline-success"
                                        size="sm"
                                        class="font-weight-bold"
                                        :disabled="accelerationLoading"
                                        @click="triggerFileInput('importCsvFile')"
                                    >
                                        <font-awesome-icon icon="cloud-upload-alt" class="mr-1" />
                                        Importar Respostas (CSV)
                                    </b-button>
                                    <input
                                        id="importCsvFile"
                                        type="file"
                                        accept=".csv"
                                        class="d-none"
                                        @change="onImportCsvSelect"
                                    />

                                    <!-- Upload Requirements -->
                                    <b-button
                                        variant="outline-info"
                                        size="sm"
                                        class="font-weight-bold"
                                        :disabled="accelerationLoading"
                                        @click="triggerFileInput('reqFileInteractive')"
                                    >
                                        <font-awesome-icon icon="shield-alt" class="mr-1" />
                                        Upload Requisitos/Controles
                                    </b-button>
                                    <input
                                        id="reqFileInteractive"
                                        type="file"
                                        accept=".xlsx,.csv"
                                        class="d-none"
                                        @change="onRequirementsSelectInteractive"
                                    />
                                </div>

                                <!-- Acceleration Progress -->
                                <div v-if="accelerationLoading" class="mt-3 p-3 bg-light border rounded">
                                    <div class="d-flex align-items-center mb-2">
                                        <b-spinner small variant="primary" class="mr-2"></b-spinner>
                                        <span class="font-weight-bold font-size-sm text-dark">{{ accelerationStatus }}</span>
                                    </div>
                                    <b-progress :value="accelerationProgress" :max="100" animated striped variant="primary" height="8px"></b-progress>
                                </div>

                                <!-- Acceleration Results -->
                                <div v-if="accelerationResult" class="mt-3 p-3 border rounded shadow-sm" :class="accelerationResult.type === 'success' ? 'bg-success-light border-success' : 'bg-warning-light border-warning'">
                                    <div class="d-flex justify-content-between align-items-start">
                                        <div>
                                            <h6 class="font-weight-bold mb-1" :class="accelerationResult.type === 'success' ? 'text-success' : 'text-warning'">
                                                <font-awesome-icon :icon="accelerationResult.type === 'success' ? 'check-circle' : 'info-circle'" class="mr-1" />
                                                {{ accelerationResult.title }}
                                            </h6>
                                            <p class="font-size-xs text-muted mb-0">{{ accelerationResult.message }}</p>
                                        </div>
                                        <b-button size="sm" variant="link" class="text-muted p-0" @click="accelerationResult = null">
                                            <font-awesome-icon icon="times" />
                                        </b-button>
                                    </div>
                                </div>
                            </div>

                            <!-- Collapsible Model Config Panel -->
                            <div class="mt-3 pt-2 border-top">
                                <b-button variant="link" size="sm" class="text-muted p-0 font-weight-bold" @click="showModelConfig = !showModelConfig">
                                    <font-awesome-icon :icon="showModelConfig ? 'chevron-up' : 'chevron-down'" class="mr-1" />
                                    {{ $t('aiThreatModeler.switchModel') || 'Switch AI Model' }}
                                </b-button>
                                <b-collapse v-model="showModelConfig" class="mt-2">
                                    <div class="bg-light border rounded p-2">
                                        <b-form-group label="Model Name" label-class="font-weight-bold font-size-xs" class="mb-2">
                                            <b-form-input
                                                v-model="form.customModel"
                                                type="text"
                                                size="sm"
                                                placeholder="meta.llama3-70b-instruct-v1:0"
                                                class="custom-input font-size-sm"
                                            ></b-form-input>
                                        </b-form-group>
                                        <b-form-checkbox
                                            v-if="form.aiProvider === 'bedrock-mantle'"
                                            v-model="form.extendedThinking"
                                            size="sm"
                                            class="font-size-xs font-weight-bold"
                                        >
                                            {{ $t('aiThreatModeler.extendedThinking') }}
                                        </b-form-checkbox>
                                    </div>
                                </b-collapse>
                            </div>
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

                    <div v-if="jobStatus" class="text-muted font-weight-bold mb-2 mt-4">
                        Status: <span class="text-success uppercase">{{ jobStatus }}</span> ({{ jobProgress }}%)
                    </div>
                    <b-progress :value="jobProgress" :max="100" show-progress animated variant="success" class="my-3 mx-auto col-md-8 px-0"></b-progress>

                    <div v-if="jobStreamText" class="text-left mx-auto col-md-8 px-3 py-2 border rounded bg-dark text-light mb-3" style="max-height: 200px; overflow-y: auto; font-family: monospace; white-space: pre-wrap; font-size: 0.85rem;">
                        <div class="small font-weight-bold text-success border-bottom border-secondary pb-1 mb-2">Live AI Stream Preview</div>
                        {{ jobStreamText }}
                    </div>
                </div>
            </b-card>

            <!-- Deduplication Review View -->
            <b-card v-else-if="step === 'deduplicate-review'" class="shadow-lg border-0 mb-4">
                <template #header>
                    <div class="d-flex justify-content-between align-items-center py-2">
                        <div class="text-left">
                            <h4 class="mb-0 font-weight-bold text-success">
                                <font-awesome-icon icon="clipboard-check" class="mr-2" />
                                Revisão, Auditoria e Deduplicação Final
                            </h4>
                            <small class="text-muted">Analise a auditoria de segurança da IA e selecione quais unificações deseja aprovar antes de concluir.</small>
                        </div>
                        <b-badge variant="success" class="px-3 py-2 font-size-sm">Human-in-the-Loop</b-badge>
                    </div>
                </template>

                <b-tabs content-class="mt-4" nav-wrapper-class="mb-3" pill card>
                    <!-- Tab 1: Deduplication -->
                    <b-tab title="Deduplicação de Ameaças & Controles" active>
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

                                    <div v-if="threatModelApproved" class="text-center py-5">
                                        <font-awesome-icon icon="check-circle" size="3x" class="text-success mb-3" />
                                        <p class="text-muted font-weight-bold">Deduplicação concluída e aplicada ao modelo.</p>
                                    </div>
                                    <div v-else-if="!deduplicateProposals" class="text-center py-4">
                                        <b-alert variant="info" show class="d-flex align-items-center mb-0 text-left font-size-xs">
                                            <font-awesome-icon icon="info-circle" class="mr-2" />
                                            <div>A análise de deduplicação de controles estará disponível após concluir o refinamento.</div>
                                        </b-alert>
                                    </div>
                                    <div v-else-if="!deduplicateProposals.controlDeduplications || deduplicateProposals.controlDeduplications.length === 0" class="text-center py-5">
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
                                                <div class="form-check">
                                                    <input
                                                        type="checkbox"
                                                        v-model="selectedControlDups"
                                                        :value="proposal.id"
                                                        class="form-check-input"
                                                        :id="'ctrl-dup-' + proposal.id"
                                                    >
                                                    <label class="form-check-label font-weight-bold text-info cursor-pointer ml-4" :for="'ctrl-dup-' + proposal.id">
                                                        Unificar Controles em: <b-badge variant="info">{{ proposal.controlCategory }}</b-badge>
                                                    </label>
                                                </div>
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

                                    <div v-if="threatModelApproved" class="text-center py-5">
                                        <font-awesome-icon icon="check-circle" size="3x" class="text-success mb-3" />
                                        <p class="text-muted font-weight-bold">Deduplicação concluída e aplicada ao modelo.</p>
                                    </div>
                                    <div v-else-if="!deduplicateProposals" class="text-center py-4">
                                        <b-alert variant="info" show class="d-flex align-items-center mb-0 text-left font-size-xs">
                                            <font-awesome-icon icon="info-circle" class="mr-2" />
                                            <div>A análise de deduplicação de ameaças estará disponível após concluir o refinamento.</div>
                                        </b-alert>
                                    </div>
                                    <div v-else-if="!deduplicateProposals.threatDeduplications || deduplicateProposals.threatDeduplications.length === 0" class="text-center py-5">
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
                                                <div class="form-check">
                                                    <input
                                                        type="checkbox"
                                                        v-model="selectedThreatDups"
                                                        :value="proposal.id"
                                                        class="form-check-input"
                                                        :id="'threat-dup-' + proposal.id"
                                                    >
                                                    <label class="form-check-label font-weight-bold text-danger cursor-pointer ml-4" :for="'threat-dup-' + proposal.id">
                                                        Unificar Ameaças em: <b-badge variant="danger">{{ proposal.cellName }}</b-badge>
                                                    </label>
                                                </div>
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
                    </b-tab>

                    <!-- Tab 2: Anti-Hallucination Audit -->
                    <b-tab title="Auditoria de Alucinações">
                        <div class="text-left">
                            <div v-if="!threatModelApproved && !deduplicateProposals" class="text-center py-5 bg-light rounded border">
                                <b-alert variant="info" show class="d-flex align-items-center mb-0 mx-auto col-md-8 text-left font-size-sm">
                                    <font-awesome-icon icon="info-circle" size="lg" class="mr-3" />
                                    <div>
                                        <strong>Aviso:</strong> A auditoria de alucinações estará disponível após concluir o refinamento clicando em <strong>"Approve & Conclude"</strong> (Confirmar e Concluir) na aba anterior.
                                    </div>
                                </b-alert>
                            </div>
                            <div v-else-if="!activeHallucinationAlerts || activeHallucinationAlerts.length === 0" class="text-center py-5 bg-light rounded border">
                                <font-awesome-icon icon="check-circle" size="3x" class="text-success mb-3" />
                                <h5 class="text-success font-weight-bold">Nenhuma Inconsistência Encontrada</h5>
                                <p class="text-muted mb-0">O auditor de segurança da IA não encontrou componentes, tecnologias ou permissões alucinadas/não confirmadas.</p>
                            </div>

                            <div v-else>
                                <b-alert variant="warning" show class="d-flex align-items-center mb-3">
                                    <font-awesome-icon icon="exclamation-triangle" size="lg" class="mr-3" />
                                    <div>
                                        <strong>Alerta de Consistência de Arquitetura:</strong> A IA identificou possíveis discrepâncias entre a documentação de referência (ou respostas fornecidas) e o modelo gerado. Por favor, revise os alertas abaixo.
                                    </div>
                                </b-alert>

                                <div
                                    v-for="alert in activeHallucinationAlerts"
                                    :key="alert.id"
                                    class="border rounded p-3 mb-3 bg-white shadow-sm d-flex"
                                >
                                    <div class="mr-3 mt-1">
                                        <font-awesome-icon
                                            icon="exclamation-circle"
                                            size="lg"
                                            :class="alert.severity === 'High' ? 'text-danger' : alert.severity === 'Medium' ? 'text-warning' : 'text-info'"
                                        />
                                    </div>
                                    <div class="w-100">
                                        <div class="d-flex justify-content-between align-items-start mb-2">
                                            <h6 class="font-weight-bold mb-0 text-dark">
                                                {{ alert.targetName }}
                                                <b-badge variant="light" class="ml-2 font-weight-normal border text-muted">
                                                    {{ alert.targetType }}
                                                </b-badge>
                                            </h6>
                                            <b-badge
                                                :variant="alert.severity === 'High' ? 'danger' : alert.severity === 'Medium' ? 'warning' : 'info'"
                                            >
                                                Prioridade: {{ alert.severity }}
                                            </b-badge>
                                        </div>
                                        <p class="mb-0 text-muted font-size-sm">{{ alert.issue }}</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </b-tab>

                    <!-- Tab 3: Threat Mitigation Status -->
                    <b-tab title="Status de Mitigação de Ameaças">
                        <div class="text-left">
                            <div v-if="!threatModelApproved && !deduplicateProposals" class="text-center py-5 bg-light rounded border">
                                <b-alert variant="info" show class="d-flex align-items-center mb-0 mx-auto col-md-8 text-left font-size-sm">
                                    <font-awesome-icon icon="info-circle" size="lg" class="mr-3" />
                                    <div>
                                        <strong>Aviso:</strong> O status de mitigação das ameaças estará disponível após concluir o refinamento clicando em <strong>"Approve & Conclude"</strong> (Confirmar e Concluir) na aba anterior.
                                    </div>
                                </b-alert>
                            </div>
                            <div v-else-if="!activeMitigationStatus || activeMitigationStatus.length === 0" class="text-center py-5 bg-light rounded border">
                                <font-awesome-icon icon="info-circle" size="3x" class="text-secondary mb-3" />
                                <h5 class="text-secondary font-weight-bold">Sem Dados de Mitigação</h5>
                                <p class="text-muted mb-0">Nenhuma ameaça foi mapeada ou avaliada para este modelo ainda.</p>
                            </div>

                            <div v-else>
                                <!-- Coverage Validation Alert -->
                                <b-alert v-if="mitigationCoverageGap > 0" variant="warning" show class="d-flex align-items-center mb-3 py-2 font-size-sm">
                                    <font-awesome-icon icon="exclamation-triangle" class="mr-2" />
                                    <span><strong>Aviso de Cobertura:</strong> {{ mitigationCoverageGap }} ameaça(s) do modelo não foram avaliadas pela IA na análise de mitigação.</span>
                                </b-alert>
                                <!-- Stats Cards -->
                                <b-row class="mb-4">
                                    <b-col sm="3" class="mb-2">
                                        <b-card bg-variant="light" class="text-center border-0 shadow-sm py-2">
                                            <h3 class="mb-0 font-weight-bold text-dark">{{ activeMitigationStatus.length }}</h3>
                                            <small class="text-muted font-weight-bold">Total Avaliadas</small>
                                        </b-card>
                                    </b-col>
                                    <b-col sm="3" class="mb-2">
                                        <b-card bg-variant="success" text-variant="white" class="text-center border-0 shadow-sm py-2">
                                            <h3 class="mb-0 font-weight-bold">{{ activeMitigationStatus.filter(t => t.status === 'Mitigada').length }}</h3>
                                            <small class="font-weight-bold text-white-50">Mitigadas</small>
                                        </b-card>
                                    </b-col>
                                    <b-col sm="3" class="mb-2">
                                        <b-card bg-variant="warning" class="text-center border-0 shadow-sm py-2">
                                            <h3 class="mb-0 font-weight-bold text-dark">{{ activeMitigationStatus.filter(t => t.status === 'Parcialmente Mitigada').length }}</h3>
                                            <small class="text-muted font-weight-bold">Parciais</small>
                                        </b-card>
                                    </b-col>
                                    <b-col sm="3" class="mb-2">
                                        <b-card bg-variant="danger" text-variant="white" class="text-center border-0 shadow-sm py-2">
                                            <h3 class="mb-0 font-weight-bold">{{ activeMitigationStatus.filter(t => t.status === 'Não Mitigada').length }}</h3>
                                            <small class="font-weight-bold text-white-50">Não Mitigadas</small>
                                        </b-card>
                                    </b-col>
                                </b-row>

                                <!-- Filters and Actions -->
                                <div class="mb-3 d-flex justify-content-between align-items-center flex-wrap">
                                    <b-button-group size="sm" class="mb-2 mb-md-0">
                                        <b-button
                                            :variant="mitigationFilter === 'All' ? 'secondary' : 'outline-secondary'"
                                            @click="mitigationFilter = 'All'"
                                        >
                                            Ver Todas ({{ activeMitigationStatus.length }})
                                        </b-button>
                                        <b-button
                                            :variant="mitigationFilter === 'Mitigada' ? 'success' : 'outline-success'"
                                            @click="mitigationFilter = 'Mitigada'"
                                        >
                                            Mitigada ({{ activeMitigationStatus.filter(t => t.status === 'Mitigada').length }})
                                        </b-button>
                                        <b-button
                                            :variant="mitigationFilter === 'Parcialmente Mitigada' ? 'warning' : 'outline-warning'"
                                            @click="mitigationFilter = 'Parcialmente Mitigada'"
                                        >
                                            Parcialmente ({{ activeMitigationStatus.filter(t => t.status === 'Parcialmente Mitigada').length }})
                                        </b-button>
                                        <b-button
                                            :variant="mitigationFilter === 'Não Mitigada' ? 'danger' : 'outline-danger'"
                                            @click="mitigationFilter = 'Não Mitigada'"
                                        >
                                            Não Mitigada ({{ activeMitigationStatus.filter(t => t.status === 'Não Mitigada').length }})
                                        </b-button>
                                    </b-button-group>
                                    
                                    <b-button size="sm" variant="primary" @click="downloadMitigationCsv" class="font-weight-bold">
                                        <font-awesome-icon icon="download" class="mr-1" /> Baixar Relatório (CSV)
                                    </b-button>
                                </div>

                                <!-- Accordion List -->
                                <div class="accordion" role="tablist">
                                    <b-card
                                        v-for="(threat, index) in activeMitigationStatus.filter(t => mitigationFilter === 'All' || t.status === mitigationFilter)"
                                        :key="threat.threatId"
                                        no-body
                                        class="mb-2 shadow-sm border-0"
                                    >
                                        <b-card-header header-tag="header" class="p-1" role="tab">
                                            <b-button block v-b-toggle="'accordion-' + threat.threatId" variant="light" class="text-left font-weight-bold d-flex justify-content-between align-items-center py-3 px-3">
                                                <div>
                                                    <span class="text-dark" style="font-size: 1.05rem;">{{ threat.threatTitle }}</span>
                                                    <div class="mt-1">
                                                        <small class="text-muted mr-3"><font-awesome-icon icon="microchip" class="mr-1"/>{{ threat.elementName }}</small>
                                                    </div>
                                                </div>
                                                <div class="d-flex align-items-center">
                                                    <b-badge
                                                        :variant="threat.status === 'Mitigada' ? 'success' : threat.status === 'Parcialmente Mitigada' ? 'warning' : 'danger'"
                                                        class="px-3 py-2 font-size-sm"
                                                    >
                                                        {{ threat.status }}
                                                    </b-badge>
                                                    <font-awesome-icon icon="chevron-down" class="ml-3 text-muted" />
                                                </div>
                                            </b-button>
                                        </b-card-header>
                                        <b-collapse :id="'accordion-' + threat.threatId" accordion="mitigation-accordion" role="tabpanel">
                                            <b-card-body>
                                                <b-row>
                                                    <!-- Left Column: Original Threat Info -->
                                                    <b-col md="6" class="border-right pr-4">
                                                        <h6 class="font-weight-bold text-dark mb-3">
                                                            <font-awesome-icon icon="bug" class="mr-2 text-danger" />
                                                            Contexto Original da Ameaça
                                                        </h6>
                                                        <div class="mb-3">
                                                            <div class="font-weight-bold font-size-sm text-secondary mb-1">Descrição do Cenário:</div>
                                                            <p class="font-size-sm text-dark bg-light p-2 rounded border">{{ threat.originalDescription || 'N/A' }}</p>
                                                        </div>
                                                        <div>
                                                            <div class="font-weight-bold font-size-sm text-secondary mb-1">Mitigação Planejada:</div>
                                                            <p class="font-size-sm text-dark bg-light p-2 rounded border">{{ threat.originalMitigation || threat.recommendations || 'N/A' }}</p>
                                                        </div>
                                                    </b-col>
                                                    <!-- Right Column: AI Audit & User Answers -->
                                                    <b-col md="6" class="pl-4">
                                                        <h6 class="font-weight-bold text-dark mb-3">
                                                            <font-awesome-icon icon="robot" class="mr-2 text-primary" />
                                                            Auditoria e Justificativa (IA)
                                                        </h6>
                                                        <div class="mb-3">
                                                            <div class="font-weight-bold font-size-sm text-secondary mb-1">Motivo do Status:</div>
                                                            <p class="font-size-sm text-dark">{{ threat.reason }}</p>
                                                        </div>
                                                        <div v-if="threat.recommendations && threat.recommendations !== threat.originalMitigation && threat.status !== 'Mitigada'" class="mb-3">
                                                            <div class="font-weight-bold font-size-sm text-warning-dark mb-1">Recomendações Adicionais:</div>
                                                            <p class="font-size-sm text-dark">{{ threat.recommendations }}</p>
                                                        </div>
                                                        <div>
                                                            <div class="font-weight-bold font-size-sm text-secondary mb-2">Evidências nas Respostas:</div>
                                                            <div v-if="threat.supportingAnswers && threat.supportingAnswers.length > 0">
                                                                <div v-for="(answer, aIdx) in threat.supportingAnswers" :key="aIdx" class="mb-2 p-2 bg-white border rounded shadow-sm">
                                                                    <div class="d-flex align-items-start">
                                                                        <font-awesome-icon icon="comment-dots" class="text-info mt-1 mr-2" />
                                                                        <em class="text-muted font-size-sm" style="line-height: 1.4;">"{{ answer }}"</em>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <p v-else class="text-muted italic font-size-sm">Nenhuma referência direta nas respostas do usuário.</p>
                                                        </div>
                                                    </b-col>
                                                </b-row>
                                            </b-card-body>
                                        </b-collapse>
                                    </b-card>
                                    
                                    <div v-if="activeMitigationStatus.filter(t => mitigationFilter === 'All' || t.status === mitigationFilter).length === 0" class="text-center py-5 bg-white border rounded shadow-sm">
                                        <font-awesome-icon icon="check-circle" size="3x" class="text-muted mb-3" />
                                        <p class="text-muted font-weight-bold">Nenhuma ameaça correspondente ao filtro selecionado.</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </b-tab>

                    <!-- Tab 4: Question & Answer Review & Edit (Phase 3) -->
                    <b-tab title="Revisão de Perguntas e Respostas">
                        <div class="text-left">
                            <h5 class="font-weight-bold text-dark border-bottom pb-2 mb-3">
                                <font-awesome-icon icon="history" class="mr-2 text-warning" />
                                Histórico de Perguntas Respondidas
                            </h5>
                            <p class="text-muted font-size-sm">
                                Aqui você pode revisar as perguntas que a inteligência artificial fez durante o processo e as respostas que você forneceu. Caso identifique alguma má interpretação por parte do modelo, você pode modificar suas respostas e reiniciar o processamento.
                            </p>

                            <div v-if="!answeredQuestions || answeredQuestions.length === 0" class="text-center py-5">
                                <font-awesome-icon icon="info-circle" size="3x" class="text-muted mb-3" />
                                <p class="text-muted font-weight-bold">Nenhuma pergunta respondida nesta sessão ainda.</p>
                            </div>

                            <div v-else>
                                <!-- AI Answers Auditing/Revision Feedback -->
                                <div v-if="deduplicateProposals && deduplicateProposals.answersRevision && deduplicateProposals.answersRevision.length > 0" class="mb-4">
                                    <b-alert show variant="warning" class="shadow-sm border-0 font-size-sm">
                                        <h6 class="font-weight-bold mb-2 text-warning-dark">
                                            <font-awesome-icon icon="exclamation-triangle" class="mr-2 text-warning" />
                                            Revisões de Respostas Sugeridas pela IA
                                        </h6>
                                        <p class="mb-2 text-dark font-weight-bold font-size-xs">As respostas a seguir foram marcadas pela auditoria como precisando de melhorias:</p>
                                        <ul class="pl-3 mb-0">
                                            <li v-for="(rev, rIdx) in deduplicateProposals.answersRevision" :key="rIdx" class="mb-2 text-dark">
                                                <strong>Contexto:</strong> {{ rev.questionContext }}
                                                <div class="mt-1">
                                                    <strong>Problema:</strong> {{ rev.issueFound }}
                                                </div>
                                                <div class="mt-1 text-muted italic font-size-xs">
                                                    <strong>Recomendação:</strong> {{ rev.recommendationForUser }}
                                                </div>
                                            </li>
                                        </ul>
                                    </b-alert>
                                </div>

                                <div
                                    v-for="(aq, idx) in displayedAnsweredQuestions"
                                    :key="aq.id || idx"
                                    class="bg-light border rounded p-3 mb-3 shadow-sm"
                                >
                                    <div class="d-flex justify-content-between align-items-center mb-2">
                                        <div>
                                            <span class="badge badge-info mr-2">Q{{ idx + 1 }}</span>
                                            <strong>{{ aq.elementName || 'Componente' }}</strong> ({{ aq.category || 'Geral' }})
                                        </div>
                                        <small class="text-muted">{{ new Date(aq.timestamp).toLocaleString() }}</small>
                                    </div>
                                    <div class="text-muted font-size-sm mb-2" style="font-style: italic;">
                                        {{ aq.text }}
                                    </div>
                                    <b-form-group label="Sua Resposta:" label-class="font-weight-bold font-size-xs mb-1">
                                        <b-form-textarea
                                            v-model="aq.answer"
                                            rows="2"
                                            class="custom-input bg-white font-size-sm"
                                        ></b-form-textarea>
                                    </b-form-group>
                                </div>

                                <div class="mt-4 text-right">
                                    <b-button variant="warning" class="font-weight-bold text-dark px-4 py-2" @click="saveAndReprocess">
                                        <font-awesome-icon icon="sync" class="mr-2" />
                                        Salvar Alterações e Reprocessar Modelo
                                    </b-button>
                                </div>
                            </div>
                        </div>
                    </b-tab>
                </b-tabs>

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
            <!-- Off-screen Premium PDF print template -->
            <div id="pdf-report-template" style="position: absolute; left: 0; top: 0; width: 680px; height: 1px; overflow: hidden; opacity: 0.01; pointer-events: none; z-index: -9999; font-family: 'Outfit', 'Inter', 'Helvetica Neue', Arial, sans-serif; color: #1e293b; background-color: #ffffff; line-height: 1.6;">
                <!-- Capa / Cover Page -->
                <div class="pdf-cover-page" style="width: 100%; height: 880px; display: flex; flex-direction: column; justify-content: space-between; padding: 0 30px 30px 30px; box-sizing: border-box;">
                    <div>
                        <!-- Logo / Header -->
                        <div style="display: flex; align-items: center; margin-bottom: 60px;">
                            <img src="@/assets/threatdragon_logo_image.svg" alt="Threat Dragon Logo" style="height: 50px; margin-right: 15px;" onerror="this.style.display='none'" />
                            <div style="font-size: 26px; font-weight: 800; color: #0f172a; letter-spacing: -0.5px;">OWASP Threat Dragon</div>
                        </div>

                        <!-- Title -->
                        <h1 style="font-size: 36px; font-weight: 900; color: #0f172a; line-height: 1.1; margin-bottom: 20px; letter-spacing: -1px;">
                            Threat Modeling Assessment Report
                        </h1>
                        <h2 style="font-size: 24px; font-weight: 600; color: #0ea5e9; margin-bottom: 40px;">
                            {{ form.title }}
                        </h2>

                        <!-- Description -->
                        <p style="font-size: 16px; color: #64748b; max-width: 600px; margin-bottom: 60px;">
                            {{ form.description || 'N/A' }}
                        </p>
                    </div>

                    <!-- Metadata Grid -->
                    <div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 60px; background-color: #f8fafc; padding: 25px; border-radius: 12px; border: 1px solid #e2e8f0;">
                            <div>
                                <span style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; font-weight: 700; display: block; margin-bottom: 5px;">Methodology</span>
                                <span style="font-size: 16px; font-weight: 700; color: #334155;">{{ form.methodology }}</span>
                            </div>
                            <div>
                                <span style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; font-weight: 700; display: block; margin-bottom: 5px;">Date Generated</span>
                                <span style="font-size: 16px; font-weight: 700; color: #334155;">{{ new Date().toLocaleDateString('pt-BR') }}</span>
                            </div>
                            <div>
                                <span style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; font-weight: 700; display: block; margin-bottom: 5px;">Completeness Score</span>
                                <span style="font-size: 16px; font-weight: 700; color: #10b981;">{{ evaluation ? evaluation.completenessScore : 0 }}%</span>
                            </div>
                            <div>
                                <span style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; font-weight: 700; display: block; margin-bottom: 5px;">Assessment Status</span>
                                <span style="font-size: 16px; font-weight: 700; color: #0ea5e9;">{{ evaluation ? evaluation.status : 'Awaiting Approval' }}</span>
                            </div>
                        </div>

                        <!-- Footer Cover -->
                        <div style="font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 20px; display: flex; justify-content: space-between;">
                            <span>CONFIDENTIAL - INTERNAL SECURITY REPORT</span>
                            <span>Powered by AI Threat Modeler</span>
                        </div>
                    </div>
                </div>

                <!-- Executive Summary Page -->
                <div class="pdf-page" style="width: 100%; page-break-before: always; padding: 40px 30px 0 30px; box-sizing: border-box;">
                    <h2 style="font-size: 24px; font-weight: 800; color: #0f172a; margin-bottom: 25px; border-bottom: 2px solid #0ea5e9; padding-bottom: 10px;">
                        1. Executive Summary
                    </h2>
                    
                    <div style="background-color: #f0f9ff; border-left: 5px solid #0ea5e9; border-radius: 6px; padding: 20px; margin-bottom: 30px;">
                        <h4 style="font-size: 16px; font-weight: 700; color: #0369a1; margin-bottom: 10px;">Threat Critic & Controls Audit:</h4>
                        <p style="font-size: 14px; color: #334155; margin-bottom: 0; white-space: pre-line;">
                            {{ evaluation ? evaluation.feedback : 'No feedback available.' }}
                        </p>
                    </div>

                    <!-- Statistics / Quick Stats -->
                    <div style="display: flex; gap: 20px; margin-bottom: 40px;">
                        <div style="flex: 1; text-align: center; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px;">
                            <span style="font-size: 32px; font-weight: 800; color: #0f172a; display: block; line-height: 1;">{{ generatedModel ? generatedModel.detail.diagrams[0].cells.filter(c => c.type !== 'tm.Boundary').length : 0 }}</span>
                            <span style="font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase;">DFD Components</span>
                        </div>
                        <div style="flex: 1; text-align: center; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px;">
                            <span style="font-size: 32px; font-weight: 800; color: #0f172a; display: block; line-height: 1;">{{ totalThreats }}</span>
                            <span style="font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase;">Identified Threats</span>
                        </div>
                        <div style="flex: 1; text-align: center; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px;">
                            <span style="font-size: 32px; font-weight: 800; color: #10b981; display: block; line-height: 1;">{{ evaluation ? evaluation.completenessScore : 0 }}%</span>
                            <span style="font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase;">Model Progress</span>
                        </div>
                    </div>
                </div>

                <!-- Framework Coverage Page -->
                <div class="pdf-page" style="width: 100%; page-break-before: always; padding: 40px 30px 0 30px; box-sizing: border-box;" v-if="questionPlan">
                    <h2 style="font-size: 24px; font-weight: 800; color: #0f172a; margin-bottom: 25px; border-bottom: 2px solid #0ea5e9; padding-bottom: 10px;">
                        2. Framework Coverage Analysis
                    </h2>
                    <p style="font-size: 14px; color: #64748b; margin-bottom: 30px;">
                        Below is the completion status of threat modeling categories mapped from the DFD components and boundaries for the <strong>{{ form.methodology }}</strong> framework:
                    </p>

                    <!-- Category Coverage bars -->
                    <div style="margin-bottom: 40px;">
                        <div v-for="(progress, cat) in questionPlan.byCategory" :key="cat" style="margin-bottom: 15px;">
                            <div style="display: flex; justify-content: space-between; font-size: 13px; font-weight: 600; color: #334155; margin-bottom: 4px;">
                                <span>{{ cat }}</span>
                                <span>{{ progress.answered }}/{{ progress.total }} answered ({{ Math.round((progress.answered / progress.total) * 100) }}%)</span>
                            </div>
                            <div style="height: 10px; background-color: #f1f5f9; border-radius: 5px; overflow: hidden; width: 100%;">
                                <div :style="{ width: (progress.total > 0 ? ((progress.answered / progress.total) * 100) : 0) + '%', backgroundColor: '#0ea5e9', height: '100%', borderRadius: '5px' }"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Visual DFD Diagram Page -->
                <div class="pdf-page pdf-landscape-page" style="width: 1000px; height: 670px; page-break-before: always; padding: 40px 30px 30px 30px; box-sizing: border-box; background-color: #ffffff;" v-if="generatedModel && generatedModel.detail && generatedModel.detail.diagrams && generatedModel.detail.diagrams[0]">
                    <h2 style="font-size: 24px; font-weight: 800; color: #0f172a; margin-bottom: 25px; border-bottom: 2px solid #0ea5e9; padding-bottom: 10px;">
                        3. Visual Data Flow Diagram (DFD)
                    </h2>
                    <p style="font-size: 14px; color: #64748b; margin-bottom: 20px;">
                        The graphical system topology representing components, data flows, and trust boundaries:
                    </p>
                    <div style="width: 100%; height: 500px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; background-color: #ffffff;">
                        <td-read-only-diagram 
                            :diagram="generatedModel.detail.diagrams[0]" 
                            :width="940"
                            :height="500"
                        />
                    </div>
                </div>

                <!-- Security Control Efficacy Report Page -->
                <div class="pdf-page" style="width: 100%; page-break-before: always; padding: 40px 30px 0 30px; box-sizing: border-box;" v-if="evaluation && evaluation.controlsAssessment && evaluation.controlsAssessment.length > 0">
                    <h2 style="font-size: 24px; font-weight: 800; color: #0f172a; margin-bottom: 25px; border-bottom: 2px solid #0ea5e9; padding-bottom: 10px;">
                        4. Security Control Efficacy Assessment
                    </h2>
                    <p style="font-size: 14px; color: #64748b; margin-bottom: 20px;">
                        Audited mitigations and security controls evaluated during the interactive sessions:
                    </p>

                    <!-- Efficacy Table -->
                    <table style="width: 100%; border-collapse: collapse; font-size: 13px; text-align: left;">
                        <thead>
                            <tr style="background-color: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                                <th style="padding: 12px 10px; font-weight: 700; color: #475569; width: 25%;">Security Control</th>
                                <th style="padding: 12px 10px; font-weight: 700; color: #475569; width: 15%;">Efficacy</th>
                                <th style="padding: 12px 10px; font-weight: 700; color: #475569; width: 60%;">Critique / Recommendations</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="(item, idx) in evaluation.controlsAssessment" :key="idx" style="border-bottom: 1px solid #f1f5f9;">
                                <td style="padding: 12px 10px; font-weight: 600; color: #334155;">{{ item.securityControl }}</td>
                                <td style="padding: 12px 10px;">
                                    <span v-if="item.assessment === 'Eficaz'" style="background-color: #dcfce7; color: #15803d; padding: 4px 8px; border-radius: 4px; font-weight: 700; font-size: 11px; display: inline-block;">
                                        ✅ Eficaz
                                    </span>
                                    <span v-else style="background-color: #ffedd5; color: #c2410c; padding: 4px 8px; border-radius: 4px; font-weight: 700; font-size: 11px; display: inline-block;">
                                        ⚠️ Melhorar
                                    </span>
                                </td>
                                <td style="padding: 12px 10px; color: #475569; font-size: 12px;">{{ item.details }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- DFD Components and Threats Inventory Page -->
                <div class="pdf-page" style="width: 100%; page-break-before: always; padding: 40px 30px 0 30px; box-sizing: border-box;" v-if="generatedModel">
                    <h2 style="font-size: 24px; font-weight: 800; color: #0f172a; margin-bottom: 25px; border-bottom: 2px solid #0ea5e9; padding-bottom: 10px;">
                        5. Component Security Inventory
                    </h2>
                    <p style="font-size: 14px; color: #64748b; margin-bottom: 20px;">
                        Catalog of elements identified in the DFD topology and their associated security threats:
                    </p>

                    <div v-for="elem in sortedElementsWithThreats" :key="elem.id" style="margin-bottom: 25px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; page-break-inside: avoid;">
                        <div style="background-color: #f8fafc; padding: 12px 15px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-weight: 700; color: #334155;">{{ elem.type }}: {{ elem.name }}</span>
                            <span style="background-color: #fee2e2; color: #991b1b; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 700;">
                                {{ elem.threatsCount }} threats
                            </span>
                        </div>
                        <div style="padding: 15px; background-color: #ffffff;">
                            <div v-if="elem.threats && elem.threats.length > 0">
                                <div v-for="(threat, tIdx) in elem.threats" :key="tIdx" style="margin-bottom: 12px; border-bottom: 1px dashed #f1f5f9; padding-bottom: 10px; font-size: 12px;">
                                    <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                                        <span style="font-weight: 700; color: #0f172a;">{{ threat.title }}</span>
                                        <span :style="{ color: threat.severity === 'High' || threat.severity === 'Critical' ? '#dc2626' : '#d97706', fontWeight: '700' }">
                                            {{ threat.severity }} (Risk: {{ threat.score }})
                                        </span>
                                    </div>
                                    <div style="color: #475569; margin-bottom: 4px;"><strong>Scenario:</strong> {{ threat.description }}</div>
                                    <div style="color: #10b981; font-weight: 600;"><strong>Mitigation:</strong> {{ threat.mitigation }}</div>
                                </div>
                            </div>
                            <p v-else style="font-size: 12px; color: #94a3b8; font-style: italic; margin-bottom: 0;">
                                No threats found or mapped for this component.
                            </p>
                        </div>
                    </div>
                </div>

                <!-- Refinement History Page -->
                <div class="pdf-page" style="width: 100%; page-break-before: always; padding: 40px 30px 0 30px; box-sizing: border-box;" v-if="refinementHistory && refinementHistory.length > 0">
                    <h2 style="font-size: 24px; font-weight: 800; color: #0f172a; margin-bottom: 25px; border-bottom: 2px solid #0ea5e9; padding-bottom: 10px;">
                        6. Audit Trail & Refinement History
                    </h2>
                    <p style="font-size: 14px; color: #64748b; margin-bottom: 20px;">
                        Complete Q&A audit log history representing design refinement sessions:
                    </p>

                    <div v-for="(msg, idx) in refinementHistory" :key="idx" style="margin-bottom: 20px; page-break-inside: avoid;">
                        <div style="display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; color: #475569; margin-bottom: 5px;">
                            <span>{{ msg.role === 'user' ? '👤 User Response' : '🤖 AI Agent Prompt' }}</span>
                            <span>Round {{ Math.floor(idx / 2) + 1 }}</span>
                        </div>
                        <div :style="{
                            backgroundColor: msg.role === 'user' ? '#f8fafc' : '#f0f9ff',
                            borderLeft: msg.role === 'user' ? '4px solid #94a3b8' : '4px solid #0ea5e9',
                            borderRadius: '4px',
                            padding: '12px 15px',
                            fontSize: '13px',
                            color: '#334155',
                            whiteSpace: 'pre-line'
                        }">
                            {{ msg.text }}
                        </div>
                    </div>
                </div>

                <!-- Anti-Hallucination Page -->
                <div class="pdf-page" style="width: 100%; page-break-before: always; padding: 40px 30px 0 30px; box-sizing: border-box;" v-if="evaluation && evaluation.hallucinationAlerts && evaluation.hallucinationAlerts.length > 0">
                    <h2 style="font-size: 24px; font-weight: 800; color: #0f172a; margin-bottom: 25px; border-bottom: 2px solid #0ea5e9; padding-bottom: 10px;">
                        7. Architectural Consistency Audit (Anti-Hallucination)
                    </h2>
                    <p style="font-size: 14px; color: #64748b; margin-bottom: 20px;">
                        Potential inconsistencies identified between the system diagram/answers and the threat model definitions:
                    </p>

                    <div v-for="alert in evaluation.hallucinationAlerts" :key="alert.id" style="margin-bottom: 15px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; page-break-inside: avoid;">
                        <div :style="{
                            backgroundColor: alert.severity === 'High' ? '#fee2e2' : alert.severity === 'Medium' ? '#fef3c7' : '#e0f2fe',
                            color: alert.severity === 'High' ? '#991b1b' : alert.severity === 'Medium' ? '#92400e' : '#0369a1',
                            padding: '10px 15px',
                            fontWeight: '700',
                            fontSize: '13px',
                            display: 'flex',
                            justifyContent: 'space-between'
                        }">
                            <span>Target: {{ alert.targetName }} ({{ alert.targetType }})</span>
                            <span>Severity: {{ alert.severity }}</span>
                        </div>
                        <div style="padding: 12px 15px; font-size: 12px; color: #334155; background-color: #ffffff;">
                            {{ alert.issue }}
                        </div>
                    </div>
                </div>

                <!-- Threat Mitigation Status Page -->
                <div class="pdf-page" style="width: 100%; page-break-before: always; padding: 40px 30px 0 30px; box-sizing: border-box;" v-if="evaluation && evaluation.mitigationStatus && evaluation.mitigationStatus.length > 0">
                    <h2 style="font-size: 24px; font-weight: 800; color: #0f172a; margin-bottom: 25px; border-bottom: 2px solid #0ea5e9; padding-bottom: 10px;">
                        8. Threat Mitigation Status Assessment
                    </h2>
                    <p style="font-size: 14px; color: #64748b; margin-bottom: 20px;">
                        Assessment of whether the generated threats have been mitigated based on your feedback:
                    </p>

                    <table style="width: 100%; border-collapse: collapse; font-size: 12px; text-align: left; margin-bottom: 30px;">
                        <thead>
                            <tr style="background-color: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                                <th style="padding: 10px; font-weight: 700; color: #475569; width: 25%;">Threat / Element</th>
                                <th style="padding: 10px; font-weight: 700; color: #475569; width: 15%; text-align: center;">Status</th>
                                <th style="padding: 10px; font-weight: 700; color: #475569; width: 35%;">Reason</th>
                                <th style="padding: 10px; font-weight: 700; color: #475569; width: 25%;">Recommendations</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="threat in evaluation.mitigationStatus" :key="threat.threatId" style="border-bottom: 1px solid #f1f5f9; page-break-inside: avoid;">
                                <td style="padding: 10px;">
                                    <div style="font-weight: 700; color: #334155;">{{ threat.threatTitle }}</div>
                                    <small style="color: #64748b;">Element: {{ threat.elementName }}</small>
                                </td>
                                <td style="padding: 10px; text-align: center; vertical-align: middle;">
                                    <span :style="{
                                        backgroundColor: threat.status === 'Mitigada' ? '#dcfce7' : threat.status === 'Parcialmente Mitigada' ? '#fef3c7' : '#fee2e2',
                                        color: threat.status === 'Mitigada' ? '#166534' : threat.status === 'Parcialmente Mitigada' ? '#92400e' : '#991b1b',
                                        padding: '4px 8px',
                                        borderRadius: '4px',
                                        fontWeight: '700',
                                        fontSize: '10px',
                                        display: 'inline-block'
                                    }">
                                        {{ threat.status }}
                                    </span>
                                </td>
                                <td style="padding: 10px; color: #475569;">{{ threat.reason }}</td>
                                <td style="padding: 10px; color: #475569;">{{ threat.recommendations || 'N/A' }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
            <!-- Password Prompt Modal -->
            <b-modal
                id="password-prompt-modal"
                title="Password Required"
                header-bg-variant="dark"
                header-text-variant="light"
                ok-title="Confirmar"
                cancel-title="Cancelar"
                @ok="handlePasswordPromptOk"
            >
                <b-form-group label="Esta sessão está protegida por senha. Insira a senha:" label-for="prompt-password">
                    <b-form-input
                        id="prompt-password"
                        v-model="promptPassword"
                        type="password"
                        placeholder="Digite a senha da sessão"
                        @keyup.enter="submitPasswordPrompt"
                    ></b-form-input>
                </b-form-group>
            </b-modal>

            <!-- Delete Password Prompt Modal -->
            <b-modal
                id="delete-password-prompt-modal"
                title="Senha Requerida para Exclusão"
                header-bg-variant="danger"
                header-text-variant="light"
                ok-title="Confirmar"
                cancel-title="Cancelar"
                @ok="handleDeletePasswordPromptOk"
            >
                <b-form-group label="Esta sessão está protegida por senha. Digite a senha para confirmar a exclusão:" label-for="delete-prompt-password">
                    <b-form-input
                        id="delete-prompt-password"
                        v-model="deletePasswordPrompt"
                        type="password"
                        placeholder="Digite a senha da sessão"
                        @keyup.enter="submitDeletePasswordPrompt"
                    ></b-form-input>
                </b-form-group>
            </b-modal>
        </b-col>
    </b-row>
</template>

<script>
import { mapState } from 'vuex';
import axios from 'axios';
import { getProviderType } from '@/service/provider/providers.js';
import { PROVIDER_SELECTED } from '@/store/actions/provider.js';
import * as XLSX from 'xlsx';
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
            serverSessions: [],
            promptPassword: '',
            pendingResumeSessionId: null,
            sessionPassword: '',
            pendingDeleteSession: null,
            deletePasswordPrompt: '',
            step: 'input', // 'input', 'generating', 'interactive', 'error'
            form: {
                title: '',
                description: '',
                apiKey: '',
                password: '',
                methodology: 'STRIDE',
                aiProvider: 'gemini',
                customBaseUrl: '',
                customModel: '',
                extendedThinking: false,
                customizeStageModels: false,
                generatorModel: '',
                generatorExtendedThinking: false,
                criticModel: '',
                criticExtendedThinking: false,
                revisionModel: '',
                revisionExtendedThinking: false,
                deduplicatorModel: '',
                deduplicatorExtendedThinking: false
            },
            sessionId: null,
            evaluation: null,
            jobId: null,
            jobStatus: '',
            jobProgress: 0,
            jobError: null,
            jobStreamText: '',
            docs: [], // Array of { name, content }
            images: [], // Array of { name, data } (base64 string)
            progressIndex: 0,
            progressSteps: [
                { label: 'Reading uploaded documents (parsing DOCX)...', state: 'pending' },
                { label: 'Formulating architectural context and STRIDE rules...', state: 'pending' },
                { label: 'Invoking AI model to analyze system diagrams...', state: 'pending' },
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
            mitigationFilter: 'All',
            stats: {
                elements: 0,
                flows: 0,
                threats: 0
            },
            previewElements: [], // list of elements parsed for stats
            errorMessage: '',
            questionPlan: null,
            questionProgress: { answered: 0, total: 0, percentage: 0 },
            showModelConfig: false,
            answeredQuestions: [],
            questionAnswers: {},
            // Acceleration features
            requirementsFile: null,
            parsedRequirements: [],
            accelerationLoading: false,
            accelerationProgress: 0,
            accelerationStatus: '',
            accelerationResult: null
        };
    },
    computed: {
        ...mapState({
            providerType: (state) => getProviderType(state.provider.selected || 'local'),
            version: (state) => state.packageBuildVersion,
            existingModel: (state) => state.threatmodel.data
        }),
        sortedElementsWithThreats() {
            if (!this.generatedModel) return [];
            const result = [];
            const diagrams = this.generatedModel.detail?.diagrams || [];
            diagrams.forEach((diagram) => {
                if (diagram.cells) {
                    diagram.cells.forEach((cell) => {
                        if (cell.shape !== 'trust-boundary-curve') {
                            const name = cell.data?.name || cell.id;
                            let cellType = 'Component';
                            if (cell.shape === 'flow') {
                                cellType = 'Data Flow';
                            } else {
                                if (cell.shape === 'actor') cellType = 'Actor';
                                if (cell.shape === 'store') cellType = 'Data Store';
                                if (cell.shape === 'process') cellType = 'Process';
                            }
                            
                            const threats = cell.data?.threats || [];
                            result.push({
                                id: cell.id,
                                name,
                                type: cellType,
                                threatsCount: threats.length,
                                threats: threats.map((t) => ({
                                    title: t.title || 'Untitled Threat',
                                    severity: t.severity || 'Medium',
                                    score: t.score || '5',
                                    description: t.description || 'No description provided.',
                                    mitigation: t.mitigation || 'No mitigation documented.'
                                }))
                            });
                        }
                    });
                }
            });
            return result.sort((a, b) => b.threatsCount - a.threatsCount || a.name.localeCompare(b.name));
        },
        totalThreats() {
            return this.stats?.threats || 0;
        },
        displayedAnsweredQuestions() {
            if (!this.answeredQuestions || this.answeredQuestions.length === 0) {
                return [];
            }
            // Administrative messages to exclude
            const adminPhrases = ['aprovado', 'o dfd está completo', 'the dfd is complete', 'approved'];
            const seen = new Set();
            return this.answeredQuestions.filter((aq) => {
                // Exclude manual requests (non-framework)
                if (aq.id && aq.id.startsWith('manual-req-')) {
                    return false;
                }
                // Exclude administrative category
                if (aq.category && aq.category.toLowerCase() === 'ajuste manual') {
                    return false;
                }
                // Exclude administrative answers
                const answerLower = (aq.answer || '').toLowerCase().trim();
                if (adminPhrases.some(p => answerLower === p || answerLower === p + '.')) {
                    return false;
                }
                // Deduplicate by (text, answer) pair to avoid consolidated expansion duplicates
                const dedupeKey = `${(aq.text || '').trim().toLowerCase()}|||${answerLower}`;
                if (seen.has(dedupeKey)) {
                    return false;
                }
                seen.add(dedupeKey);
                return true;
            });
        },
        mitigationCoverageGap() {
            const totalModelThreats = this.stats?.threats || 0;
            const evaluatedThreats = (this.activeMitigationStatus || []).length;
            return Math.max(0, totalModelThreats - evaluatedThreats);
        },
        activeMitigationStatus() {
            if (this.deduplicateProposals && this.deduplicateProposals.mitigationStatus) {
                return this.deduplicateProposals.mitigationStatus;
            }
            if (this.evaluation && this.evaluation.mitigationStatus) {
                return this.evaluation.mitigationStatus;
            }
            return null;
        },
        activeHallucinationAlerts() {
            if (this.deduplicateProposals && this.deduplicateProposals.hallucinationAlerts) {
                return this.deduplicateProposals.hallucinationAlerts;
            }
            if (this.evaluation && this.evaluation.hallucinationAlerts) {
                return this.evaluation.hallucinationAlerts;
            }
            return null;
        }
    },
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
        this.fetchServerSessions();
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
        // Requirements Drop / Select (XLSX)
        onRequirementsDrop(evt) {
            const files = evt.dataTransfer.files;
            if (files.length > 0) this.handleRequirementsFile(files[0]);
        },
        onRequirementsSelect(evt) {
            const files = evt.target.files;
            if (files.length > 0) this.handleRequirementsFile(files[0]);
        },
        onRequirementsSelectInteractive(evt) {
            const files = evt.target.files;
            if (files.length > 0) {
                this.handleRequirementsFile(files[0]);
                // After parsing, apply to session
                this.$nextTick(() => {
                    if (this.parsedRequirements.length > 0) {
                        this.applyRequirementsToSession();
                    }
                });
            }
        },
        handleRequirementsFile(file) {
            if (!file) return;
            const ext = file.name.split('.').pop().toLowerCase();
            if (ext !== 'xlsx' && ext !== 'csv') {
                this.$bvToast.toast('Apenas arquivos .xlsx e .csv são suportados.', { variant: 'warning', title: 'Formato inválido' });
                return;
            }
            this.requirementsFile = file;
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = new Uint8Array(e.target.result);
                    const workbook = XLSX.read(data, { type: 'array' });
                    
                    // Try to find the "Requisitos" sheet (case-insensitive)
                    let sheetName = workbook.SheetNames.find(s => s.toLowerCase().includes('requisito'));
                    if (!sheetName) {
                        // Fallback to third sheet if exists, else first
                        sheetName = workbook.SheetNames[2] || workbook.SheetNames[0];
                    }
                    
                    const sheet = workbook.Sheets[sheetName];
                    const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: '' });
                    
                    // Map columns flexibly
                    this.parsedRequirements = jsonData.map((row) => {
                        const keys = Object.keys(row);
                        const findCol = (patterns) => {
                            const found = keys.find(k => patterns.some(p => k.toLowerCase().includes(p)));
                            return found ? row[found] : '';
                        };
                        return {
                            control: findCol(['controle', 'control', 'requisito', 'requirement', 'nome', 'name']),
                            description: findCol(['descri', 'description', 'detalhe', 'detail']),
                            category: findCol(['categori', 'category', 'dominio', 'domain', 'tipo', 'type']),
                            status: findCol(['status', 'estado', 'state', 'implementa'])
                        };
                    }).filter(r => r.control && r.control.trim() !== '');
                    
                    this.$bvToast.toast(`${this.parsedRequirements.length} requisitos extraídos da aba "${sheetName}".`, { variant: 'success', title: 'Planilha processada' });
                } catch (parseErr) {
                    console.error('Error parsing requirements file:', parseErr);
                    this.$bvToast.toast('Erro ao processar a planilha. Verifique o formato.', { variant: 'danger', title: 'Erro' });
                    this.requirementsFile = null;
                    this.parsedRequirements = [];
                }
            };
            reader.readAsArrayBuffer(file);
        },
        removeRequirements() {
            this.requirementsFile = null;
            this.parsedRequirements = [];
        },
        // Export Questions to CSV
        async exportQuestionsCsv() {
            if (!this.sessionId) return;
            this.accelerationLoading = true;
            this.accelerationProgress = 10;
            this.accelerationStatus = 'Gerando perguntas via IA...';
            this.accelerationResult = null;
            
            try {
                const response = await axios.get(`/api/ai/session/${this.sessionId}/export-questions`, { headers: this.getAuthHeaders() });
                
                const processExportData = (data) => {
                    // Convert to CSV
                    const headers = ['ID', 'Categoria', 'Componente', 'Tipo Elemento', 'Tipo Pergunta', 'Pergunta', 'Respondida', 'Resposta', 'Fonte'];
                    const csvRows = [headers.join(';')];
                    
                    (data.questions || []).forEach((q) => {
                        const row = [
                            q.id,
                            q.category,
                            q.elementName,
                            q.elementType,
                            q.type,
                            `"${(q.questionText || '').replace(/"/g, '""')}"`,
                            q.answered ? 'Sim' : 'Não',
                            `"${(q.answer || '').replace(/"/g, '""')}"`,
                            q.source || ''
                        ];
                        csvRows.push(row.join(';'));
                    });
                    
                    const csvContent = '\uFEFF' + csvRows.join('\n'); // BOM for Excel UTF-8
                    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = `${(this.form.title || 'threat-model').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-perguntas.csv`;
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                    URL.revokeObjectURL(url);
                    
                    this.accelerationLoading = false;
                    this.accelerationProgress = 0;
                    this.accelerationResult = {
                        type: 'success',
                        title: 'CSV Exportado!',
                        message: `${data.totalQuestions} perguntas exportadas (${data.answeredCount} já respondidas, ${data.pendingCount} pendentes). Preencha a coluna "Resposta" e importe de volta.`
                    };
                };

                if (response.status === 202) {
                    const result = response.data.data;
                    if (result.jobId) {
                        const pollExport = () => {
                            axios.get(`/api/ai/job/${result.jobId}/status`).then(res => {
                                const job = res.data.data;
                                this.accelerationProgress = job.progress || 50;
                                this.accelerationStatus = `Gerando perguntas via IA... ${job.progress || 0}%`;
                                
                                if (job.status === 'completed') {
                                    axios.get(`/api/ai/session/${this.sessionId}/export-questions`, { headers: this.getAuthHeaders() }).then(finalRes => {
                                        processExportData(finalRes.data.data);
                                    }).catch(fetchErr => {
                                        this.accelerationLoading = false;
                                        this.accelerationResult = {
                                            type: 'error',
                                            title: 'Erro ao baixar perguntas',
                                            message: fetchErr.message
                                        };
                                    });
                                } else if (job.status === 'failed') {
                                    this.accelerationLoading = false;
                                    this.accelerationResult = {
                                        type: 'error',
                                        title: 'Erro na geração de perguntas',
                                        message: job.error || 'Erro desconhecido.'
                                    };
                                } else {
                                    setTimeout(pollExport, 2000);
                                }
                            }).catch(pollErr => {
                                this.accelerationLoading = false;
                                this.accelerationResult = {
                                    type: 'error',
                                    title: 'Erro de polling',
                                    message: pollErr.message
                                };
                            });
                        };
                        pollExport();
                    } else {
                        this.accelerationLoading = false;
                        this.accelerationResult = {
                            type: 'error',
                            title: 'Erro de geração',
                            message: 'Nenhum Job ID retornado.'
                        };
                    }
                } else {
                    processExportData(response.data.data);
                }
            } catch (err) {
                console.error('Export error:', err);
                this.accelerationLoading = false;
                this.accelerationResult = {
                    type: 'error',
                    title: 'Erro na exportação',
                    message: err.response?.data?.message || err.message
                };
            }
        },
        // Import Answers from CSV
        async onImportCsvSelect(evt) {
            const file = evt.target.files[0];
            if (!file || !this.sessionId) return;
            
            this.accelerationLoading = true;
            this.accelerationProgress = 20;
            this.accelerationStatus = 'Lendo arquivo CSV...';
            this.accelerationResult = null;
            
            try {
                const text = await file.text();
                const lines = text.split('\n').filter(l => l.trim() !== '');
                if (lines.length < 2) {
                    throw new Error('CSV vazio ou sem dados.');
                }
                
                // Detect separator (semicolon or comma)
                const sep = lines[0].includes(';') ? ';' : ',';
                const headerLine = lines[0].replace(/^\uFEFF/, ''); // Remove BOM
                const headers = headerLine.split(sep).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
                
                // Find column indices
                const idIdx = headers.findIndex(h => h === 'id');
                const answerIdx = headers.findIndex(h => h === 'resposta' || h === 'answer' || (h.includes('resposta') && !h.includes('tipo') && !h.includes('type')));
                const questionIdx = headers.findIndex(h => h === 'pergunta' || h === 'question' || h === 'questiontext' || (h.includes('pergunta') && !h.includes('tipo') && !h.includes('type')));
                const categoryIdx = headers.findIndex(h => h === 'categoria' || h === 'category' || (h.includes('categori') && !h.includes('tipo') && !h.includes('type')));
                const elementIdx = headers.findIndex(h => h === 'componente' || h === 'elementname' || (h.includes('componente') && !h.includes('tipo') && !h.includes('type')));
                
                if (idIdx === -1 || answerIdx === -1) {
                    throw new Error('CSV deve conter colunas "ID" e "Resposta" (ou "Answer").');
                }
                
                // Parse answers
                const answers = [];
                for (let i = 1; i < lines.length; i++) {
                    const cols = this.parseCsvLine(lines[i], sep);
                    const id = (cols[idIdx] || '').trim();
                    const answer = (cols[answerIdx] || '').trim();
                    
                    if (id && answer) {
                        answers.push({
                            id,
                            answer,
                            questionText: questionIdx !== -1 ? (cols[questionIdx] || '').trim() : '',
                            category: categoryIdx !== -1 ? (cols[categoryIdx] || '').trim() : '',
                            elementName: elementIdx !== -1 ? (cols[elementIdx] || '').trim() : '',
                            source: 'csv_import'
                        });
                    }
                }
                
                if (answers.length === 0) {
                    throw new Error('Nenhuma resposta válida encontrada no CSV.');
                }
                
                this.accelerationProgress = 50;
                this.accelerationStatus = `Importando ${answers.length} respostas...`;
                
                // Send to backend
                const response = await axios.post(`/api/ai/session/${this.sessionId}/import-answers`, { answers }, { headers: this.getAuthHeaders() });
                const result = response.data.data;
                
                // Poll job for re-generation
                this.accelerationProgress = 70;
                this.accelerationStatus = 'Reprocessando modelo com respostas importadas...';
                
                if (result.jobId) {
                    this.step = 'generating';
                    this.progressSteps.forEach(step => step.state = 'pending');
                    this.progressIndex = 1;
                    this.jobProgress = 0;
                    this.jobStatus = 'queued';
                    this.jobStreamText = '';
                    this.accelerationLoading = false;
                    
                    this.pollJobStatus(result.jobId, (genResult) => {
                        this.progressIndex = 5;
                        this.updateLocalState(genResult);
                        this.refinementRound++;
                        
                        const prog = genResult.questionPlan && genResult.questionPlan.progress;
                        if (prog && prog.answered >= prog.total && prog.total > 0) {
                            this.$bvToast.toast('Todas as perguntas foram respondidas! Iniciando processo de Deduplicação e Auditoria automaticamente...', {
                                variant: 'success',
                                title: 'Framework Concluído',
                                autoHideDelay: 5000
                            });
                            this.approveThreatModel();
                        } else {
                            this.step = 'interactive';
                        }
                        
                        this.accelerationResult = {
                            type: 'success',
                            title: `${result.importedCount} respostas importadas!`,
                            message: `${result.importedCount} respostas aplicadas, ${result.skippedCount} ignoradas. Progresso: ${result.totalAnswered}/${result.totalQuestions} perguntas respondidas.`
                        };
                    }, (err) => {
                        this.errorMessage = err.message || 'Erro ao reprocessar modelo.';
                        this.step = 'error';
                    });
                    return;
                }
                
                this.accelerationResult = {
                    type: 'success',
                    title: `${result.importedCount} respostas importadas!`,
                    message: `${result.importedCount} respostas aplicadas, ${result.skippedCount} ignoradas.`
                };
            } catch (err) {
                console.error('Import error:', err);
                this.accelerationResult = {
                    type: 'error',
                    title: 'Erro na importação',
                    message: err.response?.data?.message || err.message
                };
            } finally {
                this.accelerationLoading = false;
                this.accelerationProgress = 0;
                // Reset file input
                const input = document.getElementById('importCsvFile');
                if (input) input.value = '';
            }
        },
        // CSV line parser that handles quoted fields
        parseCsvLine(line, sep) {
            const result = [];
            let current = '';
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                const c = line[i];
                if (inQuotes) {
                    if (c === '"') {
                        if (i + 1 < line.length && line[i + 1] === '"') {
                            current += '"';
                            i++;
                        } else {
                            inQuotes = false;
                        }
                    } else {
                        current += c;
                    }
                } else if (c === '"') {
                    inQuotes = true;
                } else if (c === sep) {
                    result.push(current);
                    current = '';
                } else {
                    current += c;
                }
            }
            result.push(current);
            return result;
        },
        // Apply Requirements to Session
        async applyRequirementsToSession() {
            if (!this.sessionId || this.parsedRequirements.length === 0) return;
            
            this.accelerationLoading = true;
            this.accelerationProgress = 10;
            this.accelerationStatus = `Analisando ${this.parsedRequirements.length} requisitos contra perguntas pendentes...`;
            this.accelerationResult = null;
            
            try {
                const response = await axios.post(`/api/ai/session/${this.sessionId}/apply-requirements`, {
                    requirements: this.parsedRequirements
                }, { headers: this.getAuthHeaders() });
                
                const result = response.data.data;
                
                if (result.jobId) {
                    // Poll for async job completion
                    const pollReq = () => {
                        axios.get(`/api/ai/job/${result.jobId}/status`).then(res => {
                            const job = res.data.data;
                            this.accelerationProgress = job.progress || 50;
                            this.accelerationStatus = `Matching via IA... ${job.progress || 0}%`;
                            
                            if (job.status === 'completed') {
                                this.accelerationLoading = false;
                                const matchResult = job.result || {};
                                this.accelerationResult = {
                                    type: 'success',
                                    title: `${matchResult.matchedCount || 0} perguntas auto-respondidas!`,
                                    message: `${matchResult.matchedCount || 0} de ${matchResult.totalPendingBefore || 0} perguntas pendentes foram respondidas automaticamente com base nos ${matchResult.totalRequirements || 0} requisitos. Restam ${matchResult.totalPendingAfter || 0} perguntas para resposta manual.`
                                };
                                // Refresh session to get updated question plan
                                this.resumeSession(this.sessionId);
                            } else if (job.status === 'failed') {
                                this.accelerationLoading = false;
                                this.accelerationResult = {
                                    type: 'error',
                                    title: 'Erro no matching',
                                    message: job.error || 'Erro desconhecido.'
                                };
                            } else {
                                setTimeout(pollReq, 2000);
                            }
                        }).catch(pollErr => {
                            this.accelerationLoading = false;
                            this.accelerationResult = {
                                type: 'error',
                                title: 'Erro no polling',
                                message: pollErr.message
                            };
                        });
                    };
                    pollReq();
                }
            } catch (err) {
                console.error('Apply requirements error:', err);
                this.accelerationLoading = false;
                this.accelerationResult = {
                    type: 'error',
                    title: 'Erro ao aplicar requisitos',
                    message: err.response?.data?.message || err.message
                };
            }
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
        // Job Polling Helper
        async pollJobStatus(jobId, successCallback, errorCallback) {
            try {
                const res = await axios.get(`/api/ai/job/${jobId}/status`);
                const job = res.data.data;
                this.jobId = job.jobId;
                this.jobStatus = job.status;
                this.jobProgress = job.progress;
                this.jobError = job.error;
                this.jobStreamText = job.streamText || '';

                // Dynamically map job.progress to progressIndex
                if (this.jobProgress < 25) {
                    this.progressIndex = 1;
                } else if (this.jobProgress < 55) {
                    this.progressIndex = 2;
                } else if (this.jobProgress < 75) {
                    this.progressIndex = 3;
                } else if (this.jobProgress < 95) {
                    this.progressIndex = 4;
                } else {
                    this.progressIndex = 5;
                }

                // Update progress step states
                this.progressSteps.forEach((step, idx) => {
                    if (this.progressIndex > idx) {
                        step.state = 'completed';
                    } else if (this.progressIndex === idx) {
                        step.state = 'active';
                    } else {
                        step.state = 'pending';
                    }
                });

                if (job.status === 'completed') {
                    this.progressSteps.forEach(step => step.state = 'completed');
                    successCallback(job.result);
                } else if (job.status === 'failed') {
                    errorCallback(new Error(job.error || 'Job execution failed.'));
                } else {
                    // Poll again after 2 seconds
                    setTimeout(() => {
                        this.pollJobStatus(jobId, successCallback, errorCallback);
                    }, 2000);
                }
            } catch (err) {
                console.error('Error polling job status:', err);
                errorCallback(err);
            }
        },
        // Initial Generation
        async generateModel() {
            this.step = 'generating';
            this.progressIndex = 0;
            this.refinementRound = 1;
            this.refinementHistory = [];
            this.progressSteps.forEach(step => step.state = 'pending');
            this.jobProgress = 0;
            this.jobStatus = 'queued';
            this.jobError = null;
            this.jobStreamText = '';

            try {
                const payload = {
                    title: this.form.title,
                    description: this.form.description,
                    docs: this.docs,
                    images: this.images,
                    requirements: this.parsedRequirements,
                    apiKey: this.form.apiKey,
                    methodology: this.form.methodology,
                    aiProvider: this.form.aiProvider,
                    customBaseUrl: this.form.customBaseUrl,
                    customModel: this.form.customModel,
                    currentModel: this.generatedModel,
                    extendedThinking: this.form.extendedThinking,
                    customizeStageModels: this.form.customizeStageModels,
                    generatorModel: this.form.generatorModel,
                    generatorExtendedThinking: this.form.generatorExtendedThinking,
                    criticModel: this.form.criticModel,
                    criticExtendedThinking: this.form.criticExtendedThinking,
                    revisionModel: this.form.revisionModel,
                    revisionExtendedThinking: this.form.revisionExtendedThinking,
                    deduplicatorModel: this.form.deduplicatorModel,
                    deduplicatorExtendedThinking: this.form.deduplicatorExtendedThinking,
                    password: this.form.password
                };

                const response = await axios.post('/api/ai/threatmodel', payload);
                const jobData = response.data.data;
                this.jobId = jobData.jobId;
                this.sessionId = jobData.sessionId;
                this.sessionPassword = this.form.password;

                this.pollJobStatus(jobData.jobId, (result) => {
                    this.progressIndex = 5;
                    this.updateLocalState(result);
                    this.dfdApproved = false;
                    this.step = 'validate-dfd';
                }, (err) => {
                    this.errorMessage = err.message || 'An error occurred during threat model generation.';
                    this.step = 'error';
                });

            } catch (err) {
                console.error(err);
                this.errorMessage = err.response?.data?.message || err.message || 'An error occurred during threat model generation.';
                this.step = 'error';
            }
        },
        async submitRefinement() {
            const answeredList = [];
            this.questions.forEach((q) => {
                const answerVal = this.questionAnswers[q.id];
                if (answerVal && answerVal.trim()) {
                    answeredList.push({
                        id: q.id,
                        text: q.text,
                        answer: answerVal.trim(),
                        elementId: q.elementId,
                        elementName: q.elementName,
                        category: q.category
                    });
                }
            });

            if (answeredList.length === 0 && !this.userResponse.trim()) {
                return;
            }

            const responseText = this.userResponse;
            this.userResponse = '';
            this.questionAnswers = {};

            this.step = 'generating';
            this.progressSteps.forEach(step => step.state = 'pending');
            this.progressIndex = 1;
            this.jobProgress = 0;
            this.jobStatus = 'queued';
            this.jobError = null;
            this.jobStreamText = '';

            try {
                const payload = {
                    title: this.form.title,
                    description: this.form.description,
                    apiKey: this.form.apiKey,
                    currentModel: this.generatedModel,
                    refinementHistory: this.refinementHistory,
                    answeredQuestions: answeredList,
                    userResponse: responseText,
                    sessionId: this.sessionId,
                    methodology: this.form.methodology,
                    aiProvider: this.form.aiProvider,
                    customBaseUrl: this.form.customBaseUrl,
                    customModel: this.form.customModel,
                    dfdApproved: this.dfdApproved,
                    threatModelApproved: this.threatModelApproved,
                    extendedThinking: this.form.extendedThinking,
                    customizeStageModels: this.form.customizeStageModels,
                    generatorModel: this.form.generatorModel,
                    generatorExtendedThinking: this.form.generatorExtendedThinking,
                    criticModel: this.form.criticModel,
                    criticExtendedThinking: this.form.criticExtendedThinking,
                    revisionModel: this.form.revisionModel,
                    revisionExtendedThinking: this.form.revisionExtendedThinking,
                    deduplicatorModel: this.form.deduplicatorModel,
                    deduplicatorExtendedThinking: this.form.deduplicatorExtendedThinking
                };

                const response = await axios.post('/api/ai/threatmodel', payload, { headers: this.getAuthHeaders() });

                if (response.status === 200) {
                    const result = response.data.data;
                    this.updateLocalState(result);
                    this.refinementRound++;
                    if (this.threatModelApproved) {
                        await this.approveThreatModel();
                    } else if (this.dfdApproved) {
                        this.step = 'interactive';
                        if (this.parsedRequirements && this.parsedRequirements.length > 0) {
                            this.applyRequirementsToSession();
                        }
                    } else {
                        this.step = 'validate-dfd';
                    }
                    return;
                }

                const jobData = response.data.data;
                this.jobId = jobData.jobId;

                this.pollJobStatus(jobData.jobId, async (result) => {
                    this.progressIndex = 5;
                    this.updateLocalState(result);
                    this.refinementRound++;
                    if (this.threatModelApproved) {
                        await this.approveThreatModel();
                    } else if (this.dfdApproved) {
                        this.step = 'interactive';
                        if (this.parsedRequirements && this.parsedRequirements.length > 0) {
                            this.applyRequirementsToSession();
                        }
                    } else {
                        this.step = 'validate-dfd';
                    }
                }, (err) => {
                    this.errorMessage = err.message || 'An error occurred during threat model refinement.';
                    this.step = 'error';
                });

            } catch (err) {
                console.error(err);
                this.errorMessage = err.response?.data?.message || err.message || 'An error occurred during threat model refinement.';
                this.step = 'error';
            }
        },
        async saveAndReprocess() {
            this.step = 'generating';
            this.progressSteps.forEach(step => step.state = 'pending');
            this.progressIndex = 1;
            this.jobProgress = 0;
            this.jobStatus = 'queued';
            this.jobError = null;
            this.jobStreamText = '';

            try {
                const response = await axios.post(`/api/ai/session/${this.sessionId}/edit-answers`, {
                    answeredQuestions: this.answeredQuestions
                }, { headers: this.getAuthHeaders() });

                const jobData = response.data.data;
                this.jobId = jobData.jobId;

                this.pollJobStatus(jobData.jobId, async (result) => {
                    this.progressIndex = 5;
                    this.updateLocalState(result);
                    this.refinementRound++;
                    if (this.threatModelApproved) {
                        await this.approveThreatModel();
                    } else if (this.dfdApproved) {
                        this.step = 'interactive';
                    } else {
                        this.step = 'validate-dfd';
                    }
                }, (err) => {
                    this.errorMessage = err.message || 'Ocorreu um erro durante o reprocessamento do modelo.';
                    this.step = 'error';
                });

            } catch (err) {
                console.error(err);
                this.errorMessage = err.response?.data?.message || err.message || 'Ocorreu um erro ao salvar as respostas alteradas.';
                this.step = 'error';
            }
        },
        updateLocalState(result) {
            const model = result.threatModel;
            if (model) {
                model.version = this.version;
                this.generatedModel = model;
            }
            this.questions = (result.questions || []).map((q, idx) => {
                if (typeof q === 'string') {
                    return {
                        id: `q-fallback-${idx}-${Date.now()}`,
                        text: q,
                        elementName: 'Sistema',
                        category: 'Geral'
                    };
                }
                if (!q.id) {
                    return {
                        ...q,
                        id: `q-fallback-${idx}-${Date.now()}`
                    };
                }
                return q;
            });
            this.questionAnswers = {};
            this.questions.forEach((q) => {
                this.$set(this.questionAnswers, q.id, '');
            });
            this.sessionId = result.sessionId || null;
            if (result.answeredQuestions !== undefined) {
                this.answeredQuestions = result.answeredQuestions || [];
            }
            if (result.refinementHistory !== undefined) {
                this.refinementHistory = result.refinementHistory || [];
            }
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

            if (result.deduplicateProposals !== undefined) {
                this.deduplicateProposals = result.deduplicateProposals;
                this.selectedControlDups = result.deduplicateProposals ? (result.deduplicateProposals.controlDeduplications || []).map(p => p.id) : [];
                this.selectedThreatDups = result.deduplicateProposals ? (result.deduplicateProposals.threatDeduplications || []).map(p => p.id) : [];
            }

            // Question plan progress tracking
            if (result.questionPlan) {
                this.questionPlan = result.questionPlan;
                this.questionProgress = result.questionPlan.progress || { answered: 0, total: result.questionPlan.totalQuestions || 0, percentage: 0 };
            }

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
                }, { headers: this.getAuthHeaders() });
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
                    this.sessionId = null;
                }
            } catch (e) {
                console.error(e);
            }
        },
        async deleteSessionFromServer(session) {
            const sessionId = typeof session === 'string' ? session : session.sessionId;
            
            // If it's the current session, we use the active password
            let password = '';
            if (this.sessionId === sessionId && this.sessionPassword) {
                password = this.sessionPassword;
            }

            const performDelete = async (passVal = '') => {
                try {
                    const headers = passVal ? { 'x-session-password': passVal } : {};
                    await axios.delete(`/api/ai/session/${sessionId}`, { headers });
                    this.$toast.success('Sessão deletada com sucesso do servidor.');
                    
                    // Remove from serverSessions list
                    this.serverSessions = this.serverSessions.filter(s => s.sessionId !== sessionId);
                    
                    // Remove from local history
                    this.deleteSessionFromHistory(sessionId);
                    
                    // Fetch updated list of sessions on server
                    await this.fetchServerSessions();
                } catch (err) {
                    console.error('Failed to delete session:', err);
                    if (err.response && (err.response.status === 401 || err.response.status === 403)) {
                        // Prompt for password
                        this.pendingDeleteSession = session;
                        this.deletePasswordPrompt = '';
                        this.$bvModal.show('delete-password-prompt-modal');
                        this.$toast.error('Senha incorreta ou necessária para exclusão.');
                    } else if (err.response && err.response.status === 404) {
                        this.$toast.warning('Sessão não encontrada no servidor, limpando do histórico local.');
                        this.deleteSessionFromHistory(sessionId);
                    } else {
                        this.$toast.error('Erro ao deletar sessão do servidor.');
                    }
                }
            };

            const confirm = await this.$bvModal.msgBoxConfirm('Tem certeza que deseja deletar esta sessão e todos os seus arquivos do servidor?', {
                title: 'Confirmar Exclusão',
                okVariant: 'danger',
                okTitle: 'Deletar',
                cancelTitle: 'Cancelar'
            });

            if (confirm) {
                await performDelete(password);
            }
        },
        handleDeletePasswordPromptOk(evt) {
            evt.preventDefault();
            this.submitDeletePasswordPrompt();
        },
        submitDeletePasswordPrompt() {
            if (!this.deletePasswordPrompt) {
                this.$toast.warning('A senha é obrigatória.');
                return;
            }
            this.$bvModal.hide('delete-password-prompt-modal');
            const session = this.pendingDeleteSession;
            const sessionId = typeof session === 'string' ? session : session.sessionId;
            
            axios.delete(`/api/ai/session/${sessionId}`, {
                headers: { 'x-session-password': this.deletePasswordPrompt }
            }).then(() => {
                this.$toast.success('Sessão deletada com sucesso do servidor.');
                this.serverSessions = this.serverSessions.filter(s => s.sessionId !== sessionId);
                this.deleteSessionFromHistory(sessionId);
                this.fetchServerSessions();
            }).catch((err) => {
                console.error(err);
                this.$toast.error('Senha incorreta ou erro ao deletar a sessão do servidor.');
            });
        },
        async resumeSession(sessionId, password = '') {
            try {
                const headers = password ? { 'x-session-password': password } : {};
                // Sync the local model (with any potential manual edits) to the server session first
                if (this.existingModel && this.existingModel.summary) {
                    await axios.put(`/api/ai/session/${sessionId}`, { currentModel: this.existingModel }, { headers });
                }

                const response = await axios.get(`/api/ai/session/${sessionId}`, { headers });
                const result = response.data.data;
                
                this.form.title = result.title || '';
                this.form.description = result.description || '';
                this.form.methodology = result.methodology || 'STRIDE';
                this.form.aiProvider = result.aiProvider || 'gemini';
                this.form.customBaseUrl = result.customBaseUrl || '';
                this.form.customModel = result.customModel || '';
                this.form.apiKey = result.apiKey || '';
                this.form.extendedThinking = result.extendedThinking === true || result.extendedThinking === 'true';
                this.form.customizeStageModels = result.customizeStageModels === true || result.customizeStageModels === 'true';
                this.form.generatorModel = result.generatorModel || '';
                this.form.generatorExtendedThinking = result.generatorExtendedThinking === true || result.generatorExtendedThinking === 'true';
                this.form.criticModel = result.criticModel || '';
                this.form.criticExtendedThinking = result.criticExtendedThinking === true || result.criticExtendedThinking === 'true';
                this.form.revisionModel = result.revisionModel || '';
                this.form.revisionExtendedThinking = result.revisionExtendedThinking === true || result.revisionExtendedThinking === 'true';
                this.form.deduplicatorModel = result.deduplicatorModel || '';
                this.form.deduplicatorExtendedThinking = result.deduplicatorExtendedThinking === true || result.deduplicatorExtendedThinking === 'true';
                
                this.updateLocalState(result);
                this.sessionPassword = password; // Set password on success!
                
                const userMsgCount = this.refinementHistory.filter(m => m.role === 'user').length;
                this.refinementRound = userMsgCount + 1;

                if (result.deduplicateProposals) {
                    this.step = 'deduplicate-review';
                } else if (this.dfdApproved) {
                    this.step = 'interactive';
                } else {
                    this.step = 'validate-dfd';
                }
            } catch (err) {
                console.error('Failed to resume session:', err);
                if (err.response && (err.response.status === 401 || err.response.status === 403)) {
                    this.pendingResumeSessionId = sessionId;
                    this.promptPassword = '';
                    this.$bvModal.show('password-prompt-modal');
                    this.$toast.error('Senha incorreta ou necessária para esta sessão.');
                } else {
                    this.$toast.error('Failed to resume the session. It may have expired or been deleted.');
                    this.clearSavedSession();
                    this.step = 'input';
                }
            }
        },
        async fetchServerSessions() {
            try {
                const response = await axios.get('/api/ai/sessions');
                this.serverSessions = response.data.data || [];
            } catch (err) {
                console.error('Failed to fetch server sessions:', err);
            }
        },
        onPromptOrResume(session) {
            if (session.hasPassword) {
                this.pendingResumeSessionId = session.sessionId;
                this.promptPassword = '';
                this.$bvModal.show('password-prompt-modal');
            } else {
                this.resumeSession(session.sessionId);
            }
        },
        handlePasswordPromptOk(evt) {
            evt.preventDefault();
            this.submitPasswordPrompt();
        },
        submitPasswordPrompt() {
            if (!this.promptPassword) {
                this.$toast.warning('A senha é obrigatória.');
                return;
            }
            this.$bvModal.hide('password-prompt-modal');
            this.resumeSession(this.pendingResumeSessionId, this.promptPassword);
        },
        getAuthHeaders() {
            const headers = {};
            if (this.sessionPassword) {
                headers['x-session-password'] = this.sessionPassword;
            }
            return headers;
        },
        async approveDfd() {
            this.dfdApproved = true;
            this.userResponse = 'Aprovado. O DFD está completo.';
            await this.submitRefinement();
        },
        async approveThreatModel() {
            this.step = 'generating-proposals';
            this.jobProgress = 0;
            this.jobStatus = 'queued';
            this.jobError = null;
            this.jobStreamText = '';
            try {
                const response = await axios.post(`/api/ai/session/${this.sessionId}/deduplicate-proposals`, {
                    aiProvider: this.form.aiProvider,
                    customBaseUrl: this.form.customBaseUrl,
                    customModel: this.form.customModel,
                    apiKey: this.form.apiKey,
                    customizeStageModels: this.form.customizeStageModels,
                    generatorModel: this.form.generatorModel,
                    generatorExtendedThinking: this.form.generatorExtendedThinking,
                    criticModel: this.form.criticModel,
                    criticExtendedThinking: this.form.criticExtendedThinking,
                    revisionModel: this.form.revisionModel,
                    revisionExtendedThinking: this.form.revisionExtendedThinking,
                    deduplicatorModel: this.form.deduplicatorModel,
                    deduplicatorExtendedThinking: this.form.deduplicatorExtendedThinking
                }, { headers: this.getAuthHeaders() });
                
                const jobData = response.data.data;
                this.jobId = jobData.jobId;

                this.pollJobStatus(jobData.jobId, async (proposals) => {
                    this.deduplicateProposals = proposals;
                    this.selectedControlDups = (proposals.controlDeduplications || []).map(p => p.id);
                    this.selectedThreatDups = (proposals.threatDeduplications || []).map(p => p.id);
                    
                    if (this.evaluation) {
                        this.$set(this.evaluation, 'hallucinationAlerts', proposals.hallucinationAlerts || []);
                        this.$set(this.evaluation, 'mitigationStatus', proposals.mitigationStatus || []);
                    }
                    
                    this.step = 'deduplicate-review';
                }, async (err) => {
                    console.error('Deduplication job failed:', err);
                    await this.confirmDeduplicationAndApprove([], []);
                });

            } catch (err) {
                console.error('Failed to start deduplication job:', err);
                await this.confirmDeduplicationAndApprove([], []);
            }
        },
        cancelDeduplication() {
            this.step = 'interactive';
        },
        viewMitigationStatus() {
            this.step = 'deduplicate-review';
            // Navigate to Tab 3 (mitigationStatus) on next tick
            this.$nextTick(() => {
                const tabs = this.$el.querySelector('.deduplicate-review .nav-pills, .card .nav-pills');
                if (tabs) {
                    const tabLinks = tabs.querySelectorAll('.nav-link');
                    if (tabLinks.length >= 3) {
                        tabLinks[2].click();
                    }
                }
            });
        },
        viewQaReview() {
            this.step = 'deduplicate-review';
            // Navigate to Tab 4 (Q&A Review) on next tick
            this.$nextTick(() => {
                const tabs = this.$el.querySelector('.deduplicate-review .nav-pills, .card .nav-pills');
                if (tabs) {
                    const tabLinks = tabs.querySelectorAll('.nav-link');
                    if (tabLinks.length >= 4) {
                        tabLinks[3].click();
                    }
                }
            });
        },
        async confirmDeduplicationAndApprove(controlDups = null, threatDups = null) {
            this.step = 'generating-proposals';
            
            const approvedControlIds = Array.isArray(controlDups) ? controlDups : this.selectedControlDups;
            const approvedThreatIds = Array.isArray(threatDups) ? threatDups : this.selectedThreatDups;

            try {
                const response = await axios.post(`/api/ai/session/${this.sessionId}/apply-deduplication`, {
                    approvedControlDeduplicationIds: approvedControlIds,
                    approvedThreatDeduplicationIds: approvedThreatIds
                }, { headers: this.getAuthHeaders() });
                
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
            
            // Anti-Hallucination Section
            markdown += `## Auditoria de Alucinações (Anti-Hallucination Audit)\n`;
            if (this.evaluation.hallucinationAlerts && this.evaluation.hallucinationAlerts.length > 0) {
                markdown += `| Alvo | Tipo | Severidade | Descrição / Alerta |\n`;
                markdown += `| --- | --- | --- | --- |\n`;
                this.evaluation.hallucinationAlerts.forEach((item) => {
                    markdown += `| ${item.targetName} | ${item.targetType} | ${item.severity} | ${item.issue.replace(/\n/g, ' ')} |\n`;
                });
                markdown += `\n`;
            } else {
                markdown += `*Nenhuma alucinação ou inconsistência de arquitetura identificada pelo auditor de IA.*\n\n`;
            }

            // Threat Mitigation Assessment Section
            markdown += `## Avaliação de Mitigação de Ameaças (Threat Mitigation Assessment)\n`;
            if (this.evaluation.mitigationStatus && this.evaluation.mitigationStatus.length > 0) {
                markdown += `| Ameaça | Componente | Status | Justificativa | Recomendações |\n`;
                markdown += `| --- | --- | --- | --- | --- |\n`;
                this.evaluation.mitigationStatus.forEach((item) => {
                    const badge = item.status === 'Mitigada' ? '✅ Mitigada' : item.status === 'Parcialmente Mitigada' ? '⚠️ Parcial' : '❌ Não Mitigada';
                    markdown += `| ${item.threatTitle} | ${item.elementName} | ${badge} | ${item.reason.replace(/\n/g, ' ')} | ${item.recommendations ? item.recommendations.replace(/\n/g, ' ') : 'N/A'} |\n`;
                });
                markdown += `\n`;
            } else {
                markdown += `*Nenhuma mitigação foi avaliada ainda.*\n\n`;
            }
            
            const dataStr = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(markdown);
            const downloadAnchor = document.createElement('a');
            downloadAnchor.setAttribute('href', dataStr);
            downloadAnchor.setAttribute('download', `${this.form.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-assessment-report.md`);
            document.body.appendChild(downloadAnchor);
            downloadAnchor.click();
            downloadAnchor.remove();
        },
        downloadMitigationCsv() {
            if (!this.activeMitigationStatus || this.activeMitigationStatus.length === 0) return;
            
            const headers = ['Ameaça', 'Componente', 'Status', 'Descrição Original', 'Mitigação Planejada', 'Justificativa IA', 'Recomendações IA', 'Evidências (Respostas)'];
            const csvRows = [headers.join(';')];
            
            // Apply current filter if needed, or export all. We will export based on the current filter to give the user control.
            const threatsToExport = this.activeMitigationStatus.filter(t => this.mitigationFilter === 'All' || t.status === this.mitigationFilter);
            
            threatsToExport.forEach(t => {
                const evidence = t.supportingAnswers ? t.supportingAnswers.join(' | ') : '';
                const row = [
                    `"${(t.threatTitle || '').replace(/"/g, '""')}"`,
                    `"${(t.elementName || '').replace(/"/g, '""')}"`,
                    `"${(t.status || '').replace(/"/g, '""')}"`,
                    `"${(t.originalDescription || '').replace(/"/g, '""')}"`,
                    `"${(t.originalMitigation || '').replace(/"/g, '""')}"`,
                    `"${(t.reason || '').replace(/"/g, '""')}"`,
                    `"${(t.recommendations || '').replace(/"/g, '""')}"`,
                    `"${(evidence).replace(/"/g, '""')}"`
                ];
                csvRows.push(row.join(';'));
            });
            
            const csvContent = '\uFEFF' + csvRows.join('\n'); // BOM for excel
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${(this.form.title || 'threat-model').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-revisao-ameacas.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        },
        async downloadPdfReport() {
            if (!this.generatedModel || !this.evaluation) return;
            
            let clone = null;
            try {
                const { jsPDF } = await import('jspdf');
                const html2canvas = (await import('html2canvas')).default;
                
                const element = document.getElementById('pdf-report-template');
                if (!element) return;
                
                // Clone the hidden element and override styles to make it visible off-screen
                clone = element.cloneNode(true);
                clone.style.position = 'absolute';
                clone.style.left = '-9999px';
                clone.style.top = '-9999px';
                clone.style.height = 'auto';
                clone.style.overflow = 'visible';
                clone.style.opacity = '1';
                clone.style.zIndex = '-9999';
                
                document.body.appendChild(clone);
                
                const doc = new jsPDF({
                    orientation: 'portrait',
                    unit: 'mm',
                    format: 'a4'
                });
                
                const pages = clone.querySelectorAll('.pdf-cover-page, .pdf-page');
                let isFirstPage = true;
                
                for (let i = 0; i < pages.length; i++) {
                    const page = pages[i];
                    const isLandscape = page.classList.contains('pdf-landscape-page');
                    
                    // Render page using html2canvas
                    const canvas = await html2canvas(page, {
                        scale: 2,
                        useCORS: true,
                        logging: false
                    });
                    
                    const pageWidth = isLandscape ? 297 : 210;
                    const pageHeight = isLandscape ? 210 : 297;
                    const margin = 15;
                    const printableWidth = pageWidth - margin * 2;
                    const printableHeight = pageHeight - margin * 2;
                    
                    // Equivalent height of a page in canvas pixels
                    const pagePixelHeight = canvas.width * (printableHeight / printableWidth);
                    
                    let y = 0;
                    while (y < canvas.height) {
                        // If it's not the very first page/slice of the document, add a new page
                        if (!isFirstPage) {
                            doc.addPage('a4', isLandscape ? 'landscape' : 'portrait');
                        }
                        isFirstPage = false;
                        
                        const sliceHeight = Math.min(pagePixelHeight, canvas.height - y);
                        
                        // Create slice canvas
                        const slice = document.createElement('canvas');
                        slice.width = canvas.width;
                        slice.height = sliceHeight;
                        const ctx = slice.getContext('2d');
                        ctx.drawImage(canvas, 0, y, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
                        
                        const imgData = slice.toDataURL('image/jpeg', 0.98);
                        
                        // Calculate image size in PDF units
                        const imgWidth = printableWidth;
                        const imgHeight = printableWidth * (sliceHeight / canvas.width);
                        
                        // Center vertically in printable area
                        const x = margin;
                        const yPos = margin + (printableHeight - imgHeight) / 2;
                        
                        doc.addImage(imgData, 'JPEG', x, yPos, imgWidth, imgHeight);
                        
                        y += pagePixelHeight;
                    }
                }
                
                const filename = `${this.form.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-assessment-report.pdf`;
                doc.save(filename);
            } catch (err) {
                console.error('Failed to generate PDF report:', err);
                this.$toast.error('Failed to generate PDF report');
            } finally {
                if (clone && clone.parentNode) {
                    clone.parentNode.removeChild(clone);
                }
            }
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

.bg-success-light {
    background-color: rgba(40, 167, 69, 0.08);
}

.bg-warning-light {
    background-color: rgba(255, 193, 7, 0.08);
}

.acceleration-tools {
    border-top-style: dashed !important;
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
