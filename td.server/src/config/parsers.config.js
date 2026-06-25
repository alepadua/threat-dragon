import express from 'express';

const config = (app) => {
    app.use(express.json({ limit: '15mb' }));
    app.use(express.urlencoded({ limit: '15mb', extended: true }));
};

export default {
    config
};
