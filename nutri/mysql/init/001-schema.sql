SET FOREIGN_KEY_CHECKS=0;

CREATE TABLE `alimentos_referencia` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `fdc_id` bigint unsigned NOT NULL,
  `nombre_fuente` varchar(255) NOT NULL,
  `energia_kcal_100g` decimal(10,3) NOT NULL,
  `energia_metodo` enum('usda','4-4-9') NOT NULL DEFAULT 'usda',
  `proteina_g_100g` decimal(10,3) NOT NULL,
  `carbohidratos_g_100g` decimal(10,3) NOT NULL,
  `grasa_g_100g` decimal(10,3) NOT NULL,
  `fibra_g_100g` decimal(10,3) DEFAULT NULL,
  `consultado_en` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_alimentos_referencia_fdc` (`fdc_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;

CREATE TABLE `credenciales_integracion_usuario` (
  `usuario_id` bigint unsigned NOT NULL,
  `proveedor` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ciphertext` varbinary(2048) NOT NULL,
  `nonce` binary(12) NOT NULL,
  `auth_tag` binary(16) NOT NULL,
  `key_version` smallint unsigned NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`usuario_id`,`proveedor`),
  CONSTRAINT `fk_credenciales_integracion_usuario` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
;

CREATE TABLE `dashboard_sessions` (
  `session_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `usuario_id` bigint unsigned NOT NULL,
  `expires_at` datetime NOT NULL,
  `revoked_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`session_id`),
  KEY `idx_dashboard_sessions_user` (`usuario_id`),
  KEY `idx_dashboard_sessions_expiry` (`expires_at`),
  CONSTRAINT `fk_dashboard_sessions_usuario` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
;

CREATE TABLE `dashboard_terms_decisions` (
  `usuario_id` bigint unsigned NOT NULL,
  `terms_version` smallint unsigned NOT NULL,
  `decision` varchar(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `decided_at` datetime NOT NULL,
  PRIMARY KEY (`usuario_id`,`terms_version`),
  CONSTRAINT `fk_dashboard_terms_usuario` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_dashboard_terms_decision` CHECK ((`decision` in (_utf8mb4'accepted',_utf8mb4'rejected')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
;

CREATE TABLE `errores_aplicacion` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `ocurrido_en` datetime(3) NOT NULL,
  `area` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `trace_id` char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `evento` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `etapa` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `accion_realizada` varchar(160) COLLATE utf8mb4_unicode_ci NOT NULL,
  `metodo_http` varchar(10) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ruta` varchar(160) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `usuario_id` bigint unsigned DEFAULT NULL,
  `codigo_error` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `nombre_error` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `http_status` smallint unsigned DEFAULT NULL,
  `upstream_http_status` smallint unsigned DEFAULT NULL,
  `descripcion_error` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_errores_ocurrido_en` (`ocurrido_en`),
  KEY `idx_errores_trace_fecha` (`trace_id`,`ocurrido_en`),
  KEY `idx_errores_area_fecha` (`area`,`ocurrido_en`),
  KEY `idx_errores_usuario_fecha` (`usuario_id`,`ocurrido_en`),
  CONSTRAINT `fk_errores_usuario` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios` (`id`) ON DELETE SET NULL,
  CONSTRAINT `chk_errores_http_status` CHECK (((`http_status` is null) or (`http_status` between 100 and 599))),
  CONSTRAINT `chk_errores_upstream_http_status` CHECK (((`upstream_http_status` is null) or (`upstream_http_status` between 100 and 599)))
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
;

CREATE TABLE `perfil_salud_usuario` (
  `usuario_id` bigint unsigned NOT NULL,
  `estado_alergias` varchar(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `alergias_detalle` text COLLATE utf8mb4_unicode_ci,
  `estado_medicamentos` varchar(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `medicamentos_detalle` text COLLATE utf8mb4_unicode_ci,
  `actualizado_en` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`usuario_id`),
  CONSTRAINT `fk_perfil_salud_usuario` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_perfil_salud_alergias` CHECK ((`estado_alergias` in (_utf8mb4'ninguna_conocida',_utf8mb4'registradas',_utf8mb4'sin_informacion'))),
  CONSTRAINT `chk_perfil_salud_medicamentos` CHECK ((`estado_medicamentos` in (_utf8mb4'ninguno',_utf8mb4'registrados',_utf8mb4'sin_informacion')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
;

CREATE TABLE `planes_entrenamiento` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `usuario_id` bigint unsigned NOT NULL,
  `objetivos` varchar(2000) COLLATE utf8mb4_unicode_ci NOT NULL,
  `contenido` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `objetivo_proteinas_g` decimal(7,2) DEFAULT NULL,
  `objetivo_carbohidratos_g` decimal(7,2) DEFAULT NULL,
  `objetivo_grasas_g` decimal(7,2) DEFAULT NULL,
  `objetivo_calorias_kcal` decimal(8,1) DEFAULT NULL,
  `objetivo_entrenamiento_proteinas_g` decimal(7,2) DEFAULT NULL,
  `objetivo_entrenamiento_carbohidratos_g` decimal(7,2) DEFAULT NULL,
  `objetivo_entrenamiento_grasas_g` decimal(7,2) DEFAULT NULL,
  `objetivo_entrenamiento_calorias_kcal` decimal(8,1) DEFAULT NULL,
  `creado_en` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_planes_entrenamiento_usuario_fecha` (`usuario_id`,`creado_en`,`id`),
  CONSTRAINT `fk_planes_entrenamiento_usuario` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_planes_entrenamiento_calorias` CHECK (((`objetivo_calorias_kcal` is null) or (`objetivo_calorias_kcal` between 0 and 100000))),
  CONSTRAINT `chk_planes_entrenamiento_carbohidratos` CHECK (((`objetivo_carbohidratos_g` is null) or (`objetivo_carbohidratos_g` between 0 and 10000))),
  CONSTRAINT `chk_planes_entrenamiento_contenido` CHECK ((char_length(trim(`contenido`)) between 1 and 30000)),
  CONSTRAINT `chk_planes_entrenamiento_grasas` CHECK (((`objetivo_grasas_g` is null) or (`objetivo_grasas_g` between 0 and 10000))),
  CONSTRAINT `chk_planes_entrenamiento_objetivo_entrenamiento_proteinas` CHECK (((`objetivo_entrenamiento_proteinas_g` is null) or (`objetivo_entrenamiento_proteinas_g` between 0 and 10000))),
  CONSTRAINT `chk_planes_entrenamiento_objetivo_entrenamiento_carbohidratos` CHECK (((`objetivo_entrenamiento_carbohidratos_g` is null) or (`objetivo_entrenamiento_carbohidratos_g` between 0 and 10000))),
  CONSTRAINT `chk_planes_entrenamiento_objetivo_entrenamiento_grasas` CHECK (((`objetivo_entrenamiento_grasas_g` is null) or (`objetivo_entrenamiento_grasas_g` between 0 and 10000))),
  CONSTRAINT `chk_planes_entrenamiento_objetivo_entrenamiento_calorias` CHECK (((`objetivo_entrenamiento_calorias_kcal` is null) or (`objetivo_entrenamiento_calorias_kcal` between 0 and 100000))),
  CONSTRAINT `chk_planes_entrenamiento_objetivos` CHECK ((char_length(trim(`objetivos`)) between 1 and 2000)),
  CONSTRAINT `chk_planes_entrenamiento_proteinas` CHECK (((`objetivo_proteinas_g` is null) or (`objetivo_proteinas_g` between 0 and 10000)))
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
;

CREATE TABLE `preferencias_usuario` (
  `usuario_id` bigint unsigned NOT NULL,
  `patron_alimentario` varchar(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `zona_horaria` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `actualizado_en` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `nutrition_day_start` time NOT NULL,
  `nutrition_day_end` time NOT NULL,
  `modo_dispositivo` varchar(12) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `alimentos_preferidos` text COLLATE utf8mb4_unicode_ci,
  `alimentos_evitar` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`usuario_id`),
  CONSTRAINT `fk_preferencias_usuario` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_preferencias_dispositivo` CHECK (((`modo_dispositivo` is null) or (`modo_dispositivo` in (_ascii'ninguno',_ascii'garmin')))),
  CONSTRAINT `chk_preferencias_patron` CHECK ((`patron_alimentario` in (_ascii'omnivoro',_ascii'vegetariano',_ascii'vegano',_ascii'pescetariano',_ascii'otro',_ascii'sin_preferencia')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
;

CREATE TABLE `referencias_busqueda_alimentos` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `termino_normalizado` varchar(191) NOT NULL,
  `alimento_referencia_id` bigint unsigned NOT NULL,
  `consultado_en` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_referencias_busqueda_termino` (`termino_normalizado`),
  KEY `idx_referencias_busqueda_alimento` (`alimento_referencia_id`),
  CONSTRAINT `fk_referencias_busqueda_alimento` FOREIGN KEY (`alimento_referencia_id`) REFERENCES `alimentos_referencia` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;

CREATE TABLE `registros_biometricos` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `usuario_id` bigint unsigned NOT NULL,
  `fuente` varchar(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `medido_en` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `peso_kg` decimal(6,2) NOT NULL,
  `edad_corporal` tinyint unsigned DEFAULT NULL,
  `grasa_pct` decimal(5,2) DEFAULT NULL,
  `metabolismo_basal_kcal` smallint unsigned DEFAULT NULL,
  `grasa_visceral` tinyint unsigned DEFAULT NULL,
  `imc` decimal(5,2) DEFAULT NULL,
  `musculo_pct` decimal(5,2) DEFAULT NULL,
  `notas` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_registros_biometricos_usuario_fecha` (`usuario_id`,`medido_en`),
  CONSTRAINT `fk_registros_biometricos_usuario` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_biometric_age` CHECK (((`edad_corporal` is null) or (`edad_corporal` between 5 and 120))),
  CONSTRAINT `chk_biometric_bmi` CHECK (((`imc` is null) or (`imc` between 8 and 90))),
  CONSTRAINT `chk_biometric_bmr` CHECK (((`metabolismo_basal_kcal` is null) or (`metabolismo_basal_kcal` between 800 and 20000))),
  CONSTRAINT `chk_biometric_fat` CHECK (((`grasa_pct` is null) or (`grasa_pct` between 0 and 80))),
  CONSTRAINT `chk_biometric_muscle` CHECK (((`musculo_pct` is null) or (`musculo_pct` between 0 and 80))),
  CONSTRAINT `chk_biometric_source` CHECK ((`fuente` in (_utf8mb4'manual',_utf8mb4'bia',_utf8mb4'mifflin'))),
  CONSTRAINT `chk_biometric_source_metrics` CHECK (((`fuente` = _utf8mb4'bia') or ((`fuente` = _utf8mb4'mifflin') and (`edad_corporal` is null) and (`grasa_pct` is null) and (`grasa_visceral` is null) and (`imc` is null) and (`musculo_pct` is null)) or ((`fuente` = _utf8mb4'manual') and (`edad_corporal` is null) and (`grasa_pct` is null) and (`metabolismo_basal_kcal` is null) and (`grasa_visceral` is null) and (`imc` is null) and (`musculo_pct` is null)))),
  CONSTRAINT `chk_biometric_visceral` CHECK (((`grasa_visceral` is null) or (`grasa_visceral` <= 59))),
  CONSTRAINT `chk_biometric_weight` CHECK ((`peso_kg` between 20 and 400))
) ENGINE=InnoDB AUTO_INCREMENT=28 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
;

CREATE TABLE `registros_comida_interacciones` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `registro_comida_id` bigint unsigned NOT NULL,
  `role` enum('user','assistant') NOT NULL,
  `contenido` text NOT NULL,
  `request_id` char(36) DEFAULT NULL,
  `creado_en` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_registros_comida_interacciones_request` (`request_id`),
  KEY `idx_comida_interacciones_evento` (`registro_comida_id`,`id`),
  CONSTRAINT `fk_comida_interacciones_evento` FOREIGN KEY (`registro_comida_id`) REFERENCES `registros_comidas` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_comida_interacciones_contenido` CHECK ((char_length(trim(`contenido`)) between 1 and 5000))
) ENGINE=InnoDB AUTO_INCREMENT=368 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;

CREATE TABLE `registros_comida_items` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `registro_comida_id` bigint unsigned NOT NULL,
  `alimento_referencia_id` bigint unsigned DEFAULT NULL,
  `nombre_fuente_web` varchar(255) DEFAULT NULL,
  `url_fuente_web` varchar(1000) DEFAULT NULL,
  `cita_fuente` varchar(1200) DEFAULT NULL,
  `fragmento_original` varchar(500) NOT NULL,
  `nombre_alimento` varchar(150) NOT NULL,
  `cantidad_texto` varchar(100) DEFAULT NULL,
  `cantidad_g` decimal(10,3) DEFAULT NULL,
  `base_macros` enum('per_portion','per_100g') NOT NULL DEFAULT 'per_portion',
  `fuente_macros` enum('usda_fdc','declarado_usuario','webfetch','opencode_estimado') NOT NULL,
  `estado_macros` enum('estimado','declarado') NOT NULL DEFAULT 'declarado',
  `metodo_energia` enum('usda','4-4-9','declarado_usuario','webfetch','opencode_estimado') NOT NULL DEFAULT 'usda',
  `energia_kcal` decimal(10,2) DEFAULT NULL,
  `energia_449_kcal` decimal(10,2) NOT NULL,
  `proteina_g` decimal(10,2) NOT NULL,
  `carbohidratos_g` decimal(10,2) NOT NULL,
  `grasa_g` decimal(10,2) NOT NULL,
  `fibra_g` decimal(10,2) DEFAULT NULL,
  `creado_en` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_registros_comida_items_evento` (`registro_comida_id`,`id`),
  KEY `idx_registros_comida_items_referencia` (`alimento_referencia_id`),
  CONSTRAINT `fk_registros_comida_items_evento` FOREIGN KEY (`registro_comida_id`) REFERENCES `registros_comidas` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_registros_comida_items_referencia` FOREIGN KEY (`alimento_referencia_id`) REFERENCES `alimentos_referencia` (`id`) ON DELETE SET NULL,
  CONSTRAINT `chk_registros_comida_items_cantidad` CHECK (((`cantidad_g` is null) or (`cantidad_g` > 0)))
) ENGINE=InnoDB AUTO_INCREMENT=78 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;

CREATE TABLE `registros_comidas` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `usuario_id` bigint unsigned NOT NULL,
  `registro_comida_destino_id` bigint unsigned DEFAULT NULL,
  `request_id` char(36) NOT NULL,
  `fecha_consumo` date NOT NULL,
  `descripcion_original` text NOT NULL,
  `estado` enum('pendiente','requiere_aclaracion','completado','borrador_chat') NOT NULL DEFAULT 'pendiente',
  `pregunta_pendiente` text,
  `energia_kcal` decimal(10,2) DEFAULT NULL,
  `energia_449_kcal` decimal(10,2) DEFAULT NULL,
  `proteina_g` decimal(10,2) DEFAULT NULL,
  `carbohidratos_g` decimal(10,2) DEFAULT NULL,
  `grasa_g` decimal(10,2) DEFAULT NULL,
  `fibra_g` decimal(10,2) DEFAULT NULL,
  `creado_en` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `actualizado_en` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_registros_comidas_usuario_request` (`usuario_id`,`request_id`),
  KEY `idx_registros_comidas_usuario_fecha` (`usuario_id`,`fecha_consumo`,`id`),
  KEY `idx_registros_comidas_destino` (`registro_comida_destino_id`),
  CONSTRAINT `fk_registros_comidas_destino` FOREIGN KEY (`registro_comida_destino_id`) REFERENCES `registros_comidas` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_registros_comidas_usuario` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_registros_comidas_descripcion` CHECK ((char_length(trim(`descripcion_original`)) between 1 and 5000))
) ENGINE=InnoDB AUTO_INCREMENT=163 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;

CREATE TABLE `registros_entrenamientos` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `usuario_id` bigint unsigned NOT NULL,
  `origen` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual',
  `external_activity_id` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `descripcion` varchar(1200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `actividad` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL,
  `duracion_minutos` decimal(6,2) NOT NULL,
  `peso_kg` decimal(6,2) DEFAULT NULL,
  `met` decimal(4,2) DEFAULT NULL,
  `energia_kcal` decimal(8,1) NOT NULL,
  `distancia_metros` decimal(10,2) DEFAULT NULL,
  `tipo_energia` enum('estimada_met','reportada_dispositivo') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'estimada_met',
  `creado_en` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reg_ent_usuario_origen_externo` (`usuario_id`,`origen`,`external_activity_id`),
  KEY `idx_registros_entrenamientos_usuario_fecha` (`usuario_id`,`creado_en`),
  CONSTRAINT `fk_registros_entrenamientos_usuario` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_registros_entrenamientos_duracion` CHECK (((`duracion_minutos` > 0) and (`duracion_minutos` <= 1440))),
  CONSTRAINT `chk_registros_entrenamientos_energia` CHECK ((`energia_kcal` >= 0)),
  CONSTRAINT `chk_registros_entrenamientos_met` CHECK ((`met` between 0.1 and 30)),
  CONSTRAINT `chk_registros_entrenamientos_origen` CHECK ((((`origen` = _utf8mb4'manual') and (`tipo_energia` = _utf8mb4'estimada_met') and (`peso_kg` between 20 and 400) and (`met` between 0.1 and 30) and (`external_activity_id` is null) and (`distancia_metros` is null)) or ((`origen` <> _utf8mb4'manual') and (`origen` <> _utf8mb4'') and (`tipo_energia` = _utf8mb4'reportada_dispositivo') and (`peso_kg` is null) and (`met` is null) and (`external_activity_id` is not null) and ((`distancia_metros` is null) or (`distancia_metros` >= 0))))),
  CONSTRAINT `chk_registros_entrenamientos_peso` CHECK ((`peso_kg` between 20 and 400))
) ENGINE=InnoDB AUTO_INCREMENT=17 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
;

CREATE TABLE `registros_pasos_diarios` (
  `usuario_id` bigint unsigned NOT NULL,
  `fecha` date NOT NULL,
  `pasos` int unsigned NOT NULL,
  `fuente` enum('manual','garmin') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual',
  `creado_en` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `actualizado_en` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`usuario_id`,`fecha`),
  CONSTRAINT `fk_registros_pasos_diarios_usuario` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_registros_pasos_diarios_pasos` CHECK ((`pasos` <= 250000))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
;

CREATE TABLE `registros_plicometro` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `usuario_id` bigint unsigned NOT NULL,
  `fecha` date NOT NULL,
  `triceps_mm` decimal(5,2) DEFAULT NULL,
  `biceps_mm` decimal(5,2) DEFAULT NULL,
  `subescapular_mm` decimal(5,2) DEFAULT NULL,
  `suprailiaco_mm` decimal(5,2) DEFAULT NULL,
  `abdominal_mm` decimal(5,2) DEFAULT NULL,
  `muslo_anterior_mm` decimal(5,2) DEFAULT NULL,
  `pantorrilla_mm` decimal(5,2) DEFAULT NULL,
  `creado_en` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_plicometro_usuario_fecha` (`usuario_id`,`fecha`),
  CONSTRAINT `fk_plicometro_usuario` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_plicometro_pliegues` CHECK (((coalesce(`triceps_mm`,`biceps_mm`,`subescapular_mm`,`suprailiaco_mm`,`abdominal_mm`,`muslo_anterior_mm`,`pantorrilla_mm`) is not null) and ((`triceps_mm` is null) or (`triceps_mm` between 0 and 120)) and ((`biceps_mm` is null) or (`biceps_mm` between 0 and 120)) and ((`subescapular_mm` is null) or (`subescapular_mm` between 0 and 120)) and ((`suprailiaco_mm` is null) or (`suprailiaco_mm` between 0 and 120)) and ((`abdominal_mm` is null) or (`abdominal_mm` between 0 and 120)) and ((`muslo_anterior_mm` is null) or (`muslo_anterior_mm` between 0 and 120)) and ((`pantorrilla_mm` is null) or (`pantorrilla_mm` between 0 and 120))))
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;

CREATE TABLE `sesiones_comidas_opencode` (
  `usuario_id` bigint unsigned NOT NULL,
  `session_id` varchar(128) NOT NULL,
  `creado_en` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `actualizado_en` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`usuario_id`),
  UNIQUE KEY `uq_sesiones_comidas_opencode_id` (`session_id`),
  CONSTRAINT `fk_sesiones_comidas_opencode_usuario` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
;

CREATE TABLE `usuarios` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `nombre` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  `edad` tinyint unsigned NOT NULL,
  `sexo` varchar(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `estatura_cm` decimal(5,2) DEFAULT NULL,
  `pais_iso` char(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `celular_e164` varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `password_salt` binary(16) NOT NULL,
  `password_hash` binary(64) NOT NULL,
  `es_prueba` tinyint(1) NOT NULL DEFAULT '0',
  `activo` tinyint(1) NOT NULL DEFAULT '1',
  `creado_en` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_usuarios_celular_e164` (`celular_e164`),
  CONSTRAINT `chk_usuarios_edad` CHECK ((`edad` between 13 and 120)),
  CONSTRAINT `chk_usuarios_estatura_cm` CHECK (((`estatura_cm` is null) or (`estatura_cm` between 80 and 250))),
  CONSTRAINT `chk_usuarios_sexo` CHECK ((`sexo` in (_ascii'masculino',_ascii'femenino',_ascii'otro')))
) ENGINE=InnoDB AUTO_INCREMENT=25 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
;

SET FOREIGN_KEY_CHECKS=1;
