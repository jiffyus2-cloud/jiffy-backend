# Usa una imagen oficial de Node.js
FROM node:20-slim

# Crea el directorio de la app
WORKDIR /usr/src/app

# Copia archivos de configuración
COPY package*.json ./

# Instala dependencias
RUN npm install

# Copia el código
COPY . .

# Compila el proyecto NestJS
RUN npm run build

# Expone el puerto 8080
EXPOSE 8080

# Comando para iniciar
CMD [ "npm", "run", "start" ]
