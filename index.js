// Importación de dependencias
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const fs = require('fs');

// Cargar variables de entorno desde .env
dotenv.config();

// Inicialización de la aplicación Express
const app = express();
const PORT = process.env.PORT || 8080;

// Configuración de Middlewares
app.use(cors()); // Habilitar CORS para todas las rutas
app.use(express.json()); // Middleware para procesar cuerpos JSON

/**
 * Inicialización de Firebase Admin
 * Se utiliza la ruta del archivo de credenciales definida en .env
 */
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

if (!serviceAccountPath) {
    console.error('ERROR: La variable FIREBASE_SERVICE_ACCOUNT_PATH no está definida en el archivo .env');
    process.exit(1);
}

try {
    // Verificar si el archivo existe antes de inicializar
    if (fs.existsSync(serviceAccountPath)) {
        admin.initializeApp({
            credential: admin.credential.cert(require(serviceAccountPath))
        });
        console.log('Firebase Admin inicializado correctamente.');
    } else {
        throw new Error(`El archivo de credenciales no se encuentra en: ${serviceAccountPath}`);
    }
} catch (error) {
    console.error('Error al inicializar Firebase Admin:', error.message);
    process.exit(1);
}

/**
 * Endpoint de prueba: GET /api/status
 * Verifica el estado del servidor y la inicialización de Firebase
 */
app.get('/api/status', (req, res) => {
    res.status(200).json({
        status: 'online',
        message: 'Servidor Express corriendo satisfactoriamente',
        firebaseAdmin: admin.apps.length > 0 ? 'Initialized' : 'Not Initialized',
        timestamp: new Date().toISOString()
    });
});

// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
    console.log(`Endpoint de estado disponible en: http://localhost:${PORT}/api/status`);
});
