const admin = require('firebase-admin');

/**
 * Middleware para validar tokens de Firebase
 * Se asume que Firebase Admin ya fue inicializado en el archivo principal (index.js).
 */
const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    // Verificar si el header Authorization existe y tiene el formato Bearer <TOKEN>
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'No se proporcionó un token de autenticación.',
            message: 'Se requiere el header Authorization con el formato: Bearer <TOKEN>'
        });
    }

    const token = authHeader.split(' ')[1];

    try {
        // Validar el token con Firebase Admin
        const decodedToken = await admin.auth().verifyIdToken(token);
        
        // Inyectar los datos del usuario decodificado en el objeto req
        req.user = decodedToken;
        
        // Continuar con la ejecución de la petición
        next();
    } catch (error) {
        console.error('Error al verificar el token de Firebase:', error.message);
        
        // Token inválido, expirado o error interno
        return res.status(403).json({
            error: 'Token inválido o expirado.',
            message: error.message
        });
    }
};

module.exports = authMiddleware;
